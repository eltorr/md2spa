/**
 * Diagnostic reporting.
 *
 * Four output formats:
 *   pretty  human-readable with source excerpt and caret underline (default)
 *   json    machine-readable, for editors and custom tooling
 *   github  `::error file=...,line=...::message` workflow annotations
 *   junit   JUnit XML, which GitLab CI renders as a test report
 *
 * @module report
 */

import { summarize, RULES, compareDiagnostics } from './markdown/diagnostics.js';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  green: '\u001b[32m',
};

/**
 * Colour support detection: respects NO_COLOR, FORCE_COLOR and TTY-ness.
 * @param {NodeJS.WriteStream} [stream]
 * @returns {boolean}
 */
export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  if (process.env.CI && !process.env.GITHUB_ACTIONS) return false;
  return Boolean(stream && stream.isTTY);
}

/**
 * @param {boolean} enabled
 * @returns {(name: keyof typeof ANSI, text: string) => string}
 */
function makePaint(enabled) {
  return (name, text) => (enabled ? `${ANSI[name]}${text}${ANSI.reset}` : String(text));
}

const SEVERITY_COLOR = { error: 'red', warning: 'yellow', info: 'blue' };

/**
 * Render diagnostics for humans, with the offending source line and a caret span.
 *
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @param {{ sources?: Map<string,string>, color?: boolean, maxPerFile?: number }} [options]
 * @returns {string}
 */
export function formatPretty(diagnostics, options = {}) {
  const { sources = new Map(), color = supportsColor(), maxPerFile = Infinity } = options;
  const paint = makePaint(color);
  if (diagnostics.length === 0) return '';

  const sorted = diagnostics.slice().sort(compareDiagnostics);
  /** @type {Map<string, import('./markdown/diagnostics.js').Diagnostic[]>} */
  const byFile = new Map();
  for (const d of sorted) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }

  const out = [];
  for (const [file, items] of byFile) {
    const lines = sources.has(file) ? sources.get(file).split(/\r?\n/) : null;
    const shown = items.slice(0, maxPerFile);

    for (const d of shown) {
      const sev = paint(SEVERITY_COLOR[d.severity], d.severity);
      const loc = paint('cyan', `${file}:${d.line}:${d.column}`);
      out.push(`${loc}  ${sev}  ${paint('bold', d.code)}  ${d.message}`);

      const sourceLine = lines?.[d.line - 1];
      if (sourceLine !== undefined) {
        const gutter = String(d.line);
        const pad = ' '.repeat(gutter.length);
        // Tabs would desynchronise the caret from the text; render them as one space.
        const rendered = sourceLine.replace(/\t/g, ' ');
        const span = d.endLine === d.line
          ? Math.max(1, Math.min(d.endColumn - d.column, rendered.length - d.column + 1))
          : Math.max(1, rendered.length - d.column + 1);
        out.push(paint('gray', `${pad} |`));
        out.push(`${paint('gray', `${gutter} |`)} ${rendered}`);
        out.push(paint('gray', `${pad} |`) + ' ' + ' '.repeat(Math.max(0, d.column - 1))
          + paint(SEVERITY_COLOR[d.severity], '^'.repeat(span)));
      }
      if (d.hint) out.push(paint('gray', `   = hint: ${d.hint}`));
      out.push('');
    }

    if (items.length > shown.length) {
      out.push(paint('gray', `   ... and ${items.length - shown.length} more in ${file}`));
      out.push('');
    }
  }

  const counts = summarize(diagnostics);
  const parts = [];
  if (counts.error) parts.push(paint('red', `${counts.error} error${counts.error === 1 ? '' : 's'}`));
  if (counts.warning) parts.push(paint('yellow', `${counts.warning} warning${counts.warning === 1 ? '' : 's'}`));
  if (counts.info) parts.push(paint('blue', `${counts.info} note${counts.info === 1 ? '' : 's'}`));
  out.push(parts.join(paint('gray', ', ')));

  return out.join('\n');
}

/**
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @returns {string}
 */
export function formatJson(diagnostics) {
  return JSON.stringify(
    {
      summary: summarize(diagnostics),
      diagnostics: diagnostics.slice().sort(compareDiagnostics).map((d) => ({
        ...d,
        rule: RULES[d.code]?.title ?? null,
      })),
    },
    null,
    2,
  );
}

/**
 * GitHub Actions workflow commands -- these surface as inline annotations on a PR.
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @returns {string}
 */
export function formatGithub(diagnostics) {
  const level = { error: 'error', warning: 'warning', info: 'notice' };
  // Every field is author-controlled -- a filename may legally contain a newline, which
  // would otherwise split one annotation into two malformed workflow commands.
  const esc = (value) => String(value)
    .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return diagnostics
    .slice()
    .sort(compareDiagnostics)
    .map((d) => {
      const message = esc(`${d.code}: ${d.message}${d.hint ? ` (hint: ${d.hint})` : ''}`);
      return `::${level[d.severity]} file=${esc(d.file)},line=${d.line},col=${d.column},`
        + `endLine=${d.endLine},endColumn=${d.endColumn},title=${esc(d.code)}::${message}`;
    })
    .join('\n');
}

/**
 * @param {string} text
 * @returns {string}
 */
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters outright.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * JUnit XML. GitLab CI picks this up via `artifacts: reports: junit`.
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @param {{ suiteName?: string, files?: string[] }} [options]
 * @returns {string}
 */
export function formatJunit(diagnostics, options = {}) {
  const { suiteName = 'md2spa', files = [] } = options;
  const sorted = diagnostics.slice().sort(compareDiagnostics);
  /** @type {Map<string, import('./markdown/diagnostics.js').Diagnostic[]>} */
  const byFile = new Map();
  for (const f of files) byFile.set(f, []);
  for (const d of sorted) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }

  const failures = sorted.filter((d) => d.severity === 'error').length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(suiteName)}" tests="${byFile.size}" failures="${failures}" errors="0">`,
  ];

  for (const [file, items] of byFile) {
    const errors = items.filter((d) => d.severity === 'error');
    const others = items.filter((d) => d.severity !== 'error');
    lines.push(`  <testcase name="${xmlEscape(file)}" classname="markdown">`);
    if (errors.length) {
      const body = errors
        .map((d) => `${file}:${d.line}:${d.column} ${d.code} ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ''}`)
        .join('\n');
      lines.push(`    <failure message="${xmlEscape(`${errors.length} error(s)`)}" type="markdown-error">${xmlEscape(body)}</failure>`);
    }
    if (others.length) {
      const body = others
        .map((d) => `${file}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message}`)
        .join('\n');
      lines.push(`    <system-out>${xmlEscape(body)}</system-out>`);
    }
    lines.push('  </testcase>');
  }

  lines.push('</testsuite>');
  return lines.join('\n');
}

/**
 * Format dispatcher.
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @param {{ format?: 'pretty'|'json'|'github'|'junit' } & Record<string, unknown>} [options]
 * @returns {string}
 */
export function formatDiagnostics(diagnostics, options = {}) {
  switch (options.format) {
    case 'json': return formatJson(diagnostics);
    case 'github': return formatGithub(diagnostics);
    case 'junit': return formatJunit(diagnostics, options);
    default: return formatPretty(diagnostics, options);
  }
}

/**
 * Small helper for CLI status lines.
 * @param {{ color?: boolean }} [options]
 */
export function createLogger(options = {}) {
  const paint = makePaint(options.color ?? supportsColor());
  return {
    info: (msg) => process.stdout.write(`${msg}\n`),
    step: (msg) => process.stdout.write(`${paint('cyan', '>')} ${msg}\n`),
    success: (msg) => process.stdout.write(`${paint('green', 'ok')} ${msg}\n`),
    warn: (msg) => process.stderr.write(`${paint('yellow', 'warn')} ${msg}\n`),
    error: (msg) => process.stderr.write(`${paint('red', 'error')} ${msg}\n`),
    dim: (msg) => process.stdout.write(`${paint('gray', msg)}\n`),
    paint,
  };
}
