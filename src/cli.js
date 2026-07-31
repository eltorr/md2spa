#!/usr/bin/env node
/**
 * md2spa command line interface.
 *
 * Hand-rolled argument parsing -- a dependency-free tool cannot afford a dependency to
 * read its own flags. The parser is table-driven so `--help` and the accepted flags can
 * never drift apart.
 *
 * Exit codes (contract, do not change):
 *   0  success
 *   1  diagnostics (errors, or warnings under --strict)
 *   2  bad usage
 *   3  internal error
 *
 * @module cli
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadConfig, resolveDirs } from './config.js';
import { formatDiagnostics, createLogger, supportsColor } from './report.js';
import { RULES, createBag, shouldFail, summarize, compareDiagnostics } from './markdown/diagnostics.js';
import { createSlugRegistry } from './markdown/slug.js';
import { pathExists, isDirectory, readTextFile, walkDir, writeFileDeep, relPosix } from './util/fs.js';
import { normalizeRoute } from './util/path.js';
import { startDevServer, collectSources } from './serve.js';

/** @type {Readonly<Record<string, number>>} */
export const EXIT = Object.freeze({ ok: 0, diagnostics: 1, usage: 2, internal: 3 });

const MARKDOWN_RE = /\.(md|markdown|mdown|mkd)$/i;
const FORMATS = new Set(['pretty', 'json', 'github', 'junit']);

/** Tokens kept upper-case when humanising a filename into a title. Mirrors SPEC 7b. */
const ACRONYMS = new Set([
  'api', 'cli', 'cpu', 'gpu', 'ui', 'ux', 'id', 'url', 'http', 'https', 'json', 'yaml',
  'html', 'css', 'js', 'ts', 'sdk', 'os', 'io', 'ram', 'usb', 'pci', 'faq',
]);

// ---------------------------------------------------------------------------------------
// Flag tables
// ---------------------------------------------------------------------------------------

/**
 * @typedef {Object} FlagDef
 * @property {'string'|'boolean'} type
 * @property {string} [alias] single-character short form
 * @property {string} [value] placeholder shown in help, e.g. `<dir>`
 * @property {boolean} [negatable] accepts `--no-<name>`
 * @property {boolean} [hidden] omitted from help
 * @property {string} desc
 */

/** @type {Record<string, FlagDef>} */
const GLOBAL_FLAGS = {
  config: { type: 'string', alias: 'c', value: '<path>', desc: 'Config file (default: md2spa.config.json if present)' },
  help: { type: 'boolean', alias: 'h', desc: 'Show this help' },
  version: { type: 'boolean', alias: 'v', hidden: true, desc: 'Print the version' },
  color: { type: 'boolean', negatable: true, hidden: true, desc: 'Force or disable ANSI colour' },
  stack: { type: 'boolean', hidden: true, desc: 'Print a stack trace on internal errors' },
};

/** @type {Record<string, FlagDef>} */
const BUILD_FLAGS = {
  out: { type: 'string', alias: 'o', value: '<dir>', desc: 'Output directory (overrides outDir)' },
  base: { type: 'string', value: '<path>', desc: 'Base path: "auto", "/" or "/prefix/"' },
  strict: { type: 'boolean', desc: 'Treat warnings as errors' },
  spa: { type: 'boolean', negatable: true, desc: 'Emit the SPA runtime and JSON payloads' },
  quiet: { type: 'boolean', alias: 'q', desc: 'Print only diagnostics' },
};

/** @type {Record<string, { summary: string, usage: string, describe: string, flags: Record<string, FlagDef>, examples: Array<[string,string]>, run: Function }>} */
const COMMANDS = {
  build: {
    summary: 'Render contentDir into a deployable static site',
    usage: 'md2spa build [options]',
    describe: 'Parses every Markdown file under contentDir, renders the site into outDir and\n'
      + 'reports any problems it found along the way.',
    flags: BUILD_FLAGS,
    examples: [
      ['md2spa build', 'build into dist/'],
      ['md2spa build --out public', 'build for GitLab Pages (artifacts: paths: [public])'],
      ['md2spa build --base /docs/ --strict', 'pin a subpath and fail on warnings'],
    ],
    run: cmdBuild,
  },
  dev: {
    summary: 'Build, serve locally and live-reload on every save',
    usage: 'md2spa dev [options]',
    describe: 'Serves outDir over http, watches contentDir, staticDir and the config, rebuilds\n'
      + 'on change and pushes a reload to the browser. Draft pages are included.',
    flags: {
      port: { type: 'string', alias: 'p', value: '<n>', desc: 'Port to listen on (default 3000, next free port if busy)' },
      host: { type: 'string', alias: 'H', value: '<addr>', desc: 'Interface to bind (default 127.0.0.1)' },
      open: { type: 'boolean', desc: 'Open the site in your browser' },
      out: BUILD_FLAGS.out,
      base: BUILD_FLAGS.base,
      strict: BUILD_FLAGS.strict,
    },
    examples: [
      ['md2spa dev', 'serve on http://127.0.0.1:3000'],
      ['md2spa dev --port 8080 --open', 'pick a port and open a browser'],
      ['md2spa dev --host 0.0.0.0', 'reachable from another device on the LAN'],
    ],
    run: cmdDev,
  },
  check: {
    summary: 'Lint Markdown and report problems; writes nothing',
    usage: 'md2spa check [paths...] [options]',
    describe: 'Lints the given files or directories (default: contentDir). Works with no config\n'
      + 'file at all, so `npx md2spa check README.md` is useful in any repository.\n'
      + 'With no paths, route-level rules (NAV001/NAV002) run too. Cross-page link checks\n'
      + '(MD044/MD045) additionally need every page rendered, so they run during `build`.',
    flags: {
      strict: { type: 'boolean', desc: 'Treat warnings as errors' },
      format: { type: 'string', alias: 'f', value: '<fmt>', desc: 'pretty | json | github | junit' },
      'list-rules': { type: 'boolean', desc: 'Print every rule code with its default severity' },
    },
    examples: [
      ['md2spa check', 'lint everything under contentDir'],
      ['md2spa check README.md docs/', 'lint specific files and folders'],
      ['md2spa check --format junit > report.xml', 'produce a GitLab CI test report'],
    ],
    run: cmdCheck,
  },
  new: {
    summary: 'Scaffold a new page with frontmatter',
    usage: 'md2spa new <route> [options]',
    describe: 'Creates contentDir/<route>.md, or <route>/index.md when the route ends in a slash.\n'
      + 'The title is derived from the last route segment. Never overwrites a file.',
    flags: {
      title: { type: 'string', alias: 't', value: '<text>', desc: 'Title to use instead of the humanised route' },
    },
    examples: [
      ['md2spa new guide/install', 'creates content/guide/install.md -> /guide/install/'],
      ['md2spa new reference/api/', 'creates content/reference/api/index.md'],
      ['md2spa new faq --title "Frequently Asked Questions"', 'override the derived title'],
    ],
    run: cmdNew,
  },
  template: {
    summary: 'Add deployment files for a hosting target',
    usage: 'md2spa template [target]',
    describe: 'Copies a ready-to-use deployment recipe into this repository. Run with no target\n'
      + 'to list what is available. Existing files are never overwritten without --force.\n'
      + 'The recipes assume md2spa ships in this repo under src/, so CI needs no install.',
    flags: {
      force: { type: 'boolean', desc: 'Overwrite files that already exist' },
      list: { type: 'boolean', desc: 'List the available targets and exit' },
    },
    examples: [
      ['md2spa template', 'list the available targets'],
      ['md2spa template gitlab', 'add .gitlab-ci.yml for GitLab Pages'],
      ['md2spa template server', 'add a Dockerfile + nginx config for self-hosting'],
    ],
    run: cmdTemplate,
  },
  init: {
    summary: 'Scaffold a config file and a starter content tree',
    usage: 'md2spa init',
    describe: 'Writes md2spa.config.json, content/index.md and content/guide/index.md into the\n'
      + 'current directory. Existing files are left untouched.',
    flags: {},
    examples: [
      ['md2spa init', 'scaffold a site here'],
      ['md2spa init && md2spa dev', 'scaffold and start previewing'],
    ],
    run: cmdInit,
  },
};

// ---------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------

/**
 * `list-rules` -> `listRules`.
 * @param {string} name
 * @returns {string}
 */
function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/**
 * Parse `argv` against a flag table.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, `--no-flag`, short aliases (`-p 8080`,
 * `-p8080`, clustered booleans `-qh`) and `--` to stop flag parsing.
 *
 * @param {string[]} argv arguments *after* the command name
 * @param {Record<string, FlagDef>} spec
 * @returns {{ flags: Record<string, string|boolean>, positionals: string[], errors: string[] }}
 */
export function parseArgs(argv, spec) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const errors = [];

  /** @type {Record<string, string>} */
  const shorts = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.alias) shorts[def.alias] = name;
  }

  const needsValue = (name, inline, index) => {
    if (inline !== null) return { value: inline, next: index };
    const candidate = argv[index];
    // `--out --strict` is a mistake, not a value; `-` alone is a legitimate value.
    if (candidate === undefined || (candidate.startsWith('-') && candidate !== '-')) {
      errors.push(`option \`--${name}\` needs a value`);
      return null;
    }
    return { value: candidate, next: index + 1 };
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;

    if (arg === '--') {
      positionals.push(...argv.slice(i));
      break;
    }

    if (arg.startsWith('--')) {
      let name = arg.slice(2);
      let inline = null;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      let negated = false;
      if (!spec[name] && name.startsWith('no-')) {
        const base = name.slice(3);
        if (spec[base] && spec[base].type === 'boolean') {
          name = base;
          negated = true;
        }
      }

      const def = spec[name];
      if (!def) {
        errors.push(`unknown option \`${arg.split('=')[0]}\``);
        continue;
      }

      if (def.type === 'boolean') {
        if (inline !== null && inline !== 'true' && inline !== 'false') {
          errors.push(`option \`--${name}\` does not take a value`);
          continue;
        }
        flags[camel(name)] = negated ? false : inline !== 'false';
        continue;
      }

      const got = needsValue(name, inline, i);
      if (!got) continue;
      flags[camel(name)] = got.value;
      i = got.next;
      continue;
    }

    if (arg.length > 1 && arg[0] === '-') {
      const chars = arg.slice(1);
      for (let c = 0; c < chars.length; c += 1) {
        const name = shorts[chars[c]];
        const def = name ? spec[name] : undefined;
        if (!def) {
          errors.push(`unknown option \`-${chars[c]}\``);
          break;
        }
        if (def.type === 'boolean') {
          flags[camel(name)] = true;
          continue;
        }
        const rest = chars.slice(c + 1).replace(/^=/, '');
        const got = needsValue(name, rest === '' ? null : rest, i);
        if (got) {
          flags[camel(name)] = got.value;
          i = got.next;
        }
        break; // a value flag consumes the remainder of the cluster
      }
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals, errors };
}

// ---------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------

/**
 * @param {Record<string, FlagDef>} spec
 * @returns {string}
 */
function formatFlagList(spec) {
  const rows = Object.entries(spec)
    .filter(([, def]) => !def.hidden)
    .map(([name, def]) => {
      const alias = def.alias ? `-${def.alias}, ` : '    ';
      const long = def.negatable ? `--[no-]${name}` : `--${name}`;
      return [`${alias}${long}${def.value ? ` ${def.value}` : ''}`, def.desc];
    });
  if (rows.length === 0) return '  (none)';
  const width = rows.reduce((max, [flag]) => Math.max(max, flag.length), 0);
  return rows.map(([flag, desc]) => `  ${flag.padEnd(width)}  ${desc}`).join('\n');
}

/**
 * @param {Array<[string, string]>} examples
 * @returns {string}
 */
function formatExamples(examples) {
  const width = examples.reduce((max, [cmd]) => Math.max(max, cmd.length), 0);
  return examples.map(([cmd, desc]) => `  ${cmd.padEnd(width)}  # ${desc}`).join('\n');
}

/**
 * Top-level help.
 * @returns {string}
 */
export function mainHelp() {
  const commands = Object.entries(COMMANDS).map(([name, def]) => {
    const label = name === 'check' ? 'check [paths...]' : name === 'new' ? 'new <route>' : name;
    return [label, def.summary];
  });
  const width = commands.reduce((max, [label]) => Math.max(max, label.length), 0);

  return [
    'md2spa — Markdown to a static SPA documentation site. The folder tree is the navigation.',
    '',
    'Usage',
    '  md2spa <command> [options]',
    '',
    'Commands',
    ...commands.map(([label, summary]) => `  ${label.padEnd(width)}  ${summary}`),
    '',
    'Global options',
    formatFlagList({
      ...GLOBAL_FLAGS,
      version: { ...GLOBAL_FLAGS.version, hidden: false },
      color: { ...GLOBAL_FLAGS.color, hidden: false },
      stack: { ...GLOBAL_FLAGS.stack, hidden: false },
    }),
    '',
    'Examples',
    formatExamples([
      ['md2spa init && md2spa dev', 'scaffold a site and preview it with live reload'],
      ['md2spa build --out public', 'build for GitLab Pages (artifacts: paths: [public])'],
      ['md2spa check docs --format junit > report.xml', 'lint in CI and publish a JUnit report'],
    ]),
    '',
    'Deploying anywhere',
    '  The default base: "auto" emits document-relative URLs, so one build works at /, at',
    '  /user/project/ on GitLab or GitHub Pages, in a subfolder of another site, and over file://.',
    '',
    'Run `md2spa <command> --help` for command-specific options.',
  ].join('\n');
}

/**
 * Per-command help.
 * @param {string} name
 * @returns {string}
 */
export function commandHelp(name) {
  const def = COMMANDS[name];
  return [
    def.summary,
    '',
    'Usage',
    `  ${def.usage}`,
    '',
    def.describe,
    '',
    'Options',
    formatFlagList(def.flags),
    '',
    'Global options',
    formatFlagList(GLOBAL_FLAGS),
    '',
    'Examples',
    formatExamples(def.examples),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

/**
 * Diagnostics can arrive from several passes (parser, validator, renderer, build); the same
 * problem reported twice helps nobody.
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @returns {import('./markdown/diagnostics.js').Diagnostic[]}
 */
export function dedupe(diagnostics) {
  const seen = new Set();
  const out = [];
  for (const d of diagnostics) {
    const key = `${d.file}|${d.line}|${d.column}|${d.code}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort(compareDiagnostics);
}

/**
 * Turn a filename or route segment into a human title.
 * `01-getting-started` -> `Getting Started`, `api-reference` -> `API Reference`.
 * @param {string} name
 * @returns {string}
 */
export function humanize(name) {
  const words = String(name)
    .replace(MARKDOWN_RE, '')
    .replace(/^\d+[-_.]/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (word.length > 1 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
  return words.join(' ') || 'Untitled';
}

/**
 * Quote a YAML scalar only when it would otherwise be ambiguous.
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  const text = String(value);
  if (/^[A-Za-z0-9][A-Za-z0-9 ()/&.,'!+-]*$/.test(text) && !/: /.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render diagnostics in the requested format and return the exit code.
 * @param {import('./markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @param {{ cwd: string, format: string, color: boolean, strict: boolean, files?: string[],
 *           sources?: Map<string,string>, logger: ReturnType<typeof createLogger>, quiet?: boolean }} ctx
 * @returns {number}
 */
function reportDiagnostics(diagnostics, ctx) {
  const { cwd, format, color, strict, files = [], logger, quiet = false } = ctx;
  const sources = collectSources(cwd, diagnostics, ctx.sources);
  const text = formatDiagnostics(diagnostics, {
    format,
    sources,
    color,
    files,
    suiteName: 'md2spa',
  });
  if (text) process.stdout.write(`${text}\n`);
  const failed = shouldFail(diagnostics, strict);
  if (format === 'pretty' && !text && !quiet) logger.success('no problems found');
  return failed ? EXIT.diagnostics : EXIT.ok;
}

/**
 * CLI flags that map onto config keys.
 * @param {Record<string, string|boolean>} flags
 * @returns {object}
 */
function configOverrides(flags) {
  /** @type {Record<string, unknown>} */
  const overrides = {};
  if (typeof flags.out === 'string') overrides.outDir = flags.out;
  if (typeof flags.base === 'string') overrides.base = flags.base;
  if (flags.strict === true) overrides.strict = true;
  if (flags.spa === false) overrides.spa = false;
  return overrides;
}

/**
 * A logger that swallows everything except errors, for `--quiet` and machine formats.
 * @param {ReturnType<typeof createLogger>} logger
 * @returns {ReturnType<typeof createLogger>}
 */
function muted(logger) {
  const noop = () => {};
  return { ...logger, info: noop, step: noop, success: noop, dim: noop };
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/**
 * `md2spa build`
 * @param {{ cwd: string, flags: Record<string, string|boolean>, positionals: string[],
 *           logger: ReturnType<typeof createLogger>, color: boolean }} ctx
 * @returns {Promise<number>}
 */
async function cmdBuild(ctx) {
  const { cwd, flags, color } = ctx;
  const quiet = flags.quiet === true;
  const logger = quiet ? muted(ctx.logger) : ctx.logger;

  const { config, configFile, diagnostics: configDiagnostics } = await loadConfig(cwd, {
    configPath: typeof flags.config === 'string' ? flags.config : null,
    overrides: configOverrides(flags),
  });

  if (configFile) logger.dim(`config ${relPosix(cwd, configFile)}`);

  // A broken config makes every later diagnostic meaningless, so stop here.
  if (configDiagnostics.some((d) => d.severity === 'error')) {
    return reportDiagnostics(dedupe(configDiagnostics), {
      cwd, format: 'pretty', color, strict: config.strict, logger: ctx.logger, quiet,
    });
  }

  const startedAt = process.hrtime.bigint();
  const { buildSite } = await import('./build/build.js');
  const result = await buildSite({ cwd, config, logger });
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const diagnostics = dedupe([...configDiagnostics, ...((result && result.diagnostics) || [])]);
  const code = reportDiagnostics(diagnostics, {
    cwd,
    format: 'pretty',
    color,
    strict: config.strict,
    sources: result && result.sources,
    logger: ctx.logger,
    quiet,
  });

  const { outDir } = resolveDirs(cwd, config);
  const fileCount = (result && result.files && result.files.length) || 0;
  if (code === EXIT.ok) {
    logger.success(`built ${fileCount} file${fileCount === 1 ? '' : 's'} into ${relPosix(cwd, outDir)} in ${ms.toFixed(0)}ms`);
  } else {
    const counts = summarize(diagnostics);
    ctx.logger.error(counts.error > 0
      ? `build finished with ${counts.error} error${counts.error === 1 ? '' : 's'}`
      : `build finished with ${counts.warning} warning${counts.warning === 1 ? '' : 's'} and --strict is on`);
  }
  return code;
}

/**
 * `md2spa dev`
 * @param {{ cwd: string, flags: Record<string, string|boolean>, logger: ReturnType<typeof createLogger>, color: boolean }} ctx
 * @returns {Promise<number>}
 */
async function cmdDev(ctx) {
  const { cwd, flags, logger, color } = ctx;

  const port = flags.port === undefined ? 3000 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    logger.error(`--port must be an integer between 0 and 65535, got \`${flags.port}\``);
    return EXIT.usage;
  }

  const { config, configFile, diagnostics: configDiagnostics } = await loadConfig(cwd, {
    configPath: typeof flags.config === 'string' ? flags.config : null,
    overrides: configOverrides(flags),
  });

  if (configFile) logger.dim(`config ${relPosix(cwd, configFile)}`);
  if (configDiagnostics.some((d) => d.severity === 'error')) {
    return reportDiagnostics(dedupe(configDiagnostics), {
      cwd, format: 'pretty', color, strict: false, logger,
    });
  }
  if (configDiagnostics.length > 0) {
    reportDiagnostics(dedupe(configDiagnostics), { cwd, format: 'pretty', color, strict: false, logger, quiet: true });
  }

  await startDevServer({
    cwd,
    config,
    port,
    host: typeof flags.host === 'string' ? flags.host : '127.0.0.1',
    open: flags.open === true,
    logger,
    color,
  });

  // The listening server keeps the event loop alive; the process ends on SIGINT.
  return EXIT.ok;
}

/**
 * `md2spa check`
 * @param {{ cwd: string, flags: Record<string, string|boolean>, positionals: string[],
 *           logger: ReturnType<typeof createLogger>, color: boolean }} ctx
 * @returns {Promise<number>}
 */
async function cmdCheck(ctx) {
  const { cwd, flags, positionals, logger, color } = ctx;

  if (flags.listRules === true) {
    process.stdout.write(`${formatRuleTable(color)}\n`);
    return EXIT.ok;
  }

  const format = typeof flags.format === 'string' ? flags.format : 'pretty';
  if (!FORMATS.has(format)) {
    logger.error(`unknown --format \`${format}\`; expected one of ${[...FORMATS].join(', ')}`);
    return EXIT.usage;
  }
  const pretty = format === 'pretty';

  const { config, diagnostics: rawConfigDiagnostics } = await loadConfig(cwd, {
    configPath: typeof flags.config === 'string' ? flags.config : null,
    overrides: flags.strict === true ? { strict: true } : {},
  });

  const explicit = positionals.length > 0;
  // `npx md2spa check README.md` must work in a repo that has no content/ directory at all.
  const configDiagnostics = explicit
    ? rawConfigDiagnostics.filter((d) => d.code !== 'CFG003')
    : rawConfigDiagnostics;

  /** @type {string[]} */
  const targets = [];
  for (const target of explicit ? positionals : [config.contentDir]) {
    const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
    if (isDirectory(abs)) {
      for (const found of walkDir(abs, {
        filter: (rel) => MARKDOWN_RE.test(rel),
        skipDir: (name) => name === 'node_modules' || name.startsWith('.'),
      })) {
        targets.push(path.join(abs, ...found.split('/')));
      }
    } else if (pathExists(abs)) {
      targets.push(abs);
    } else if (explicit) {
      logger.error(`no such file or directory: ${target}`);
      return EXIT.usage;
    }
    // A missing default contentDir is already reported as CFG003.
  }

  if (targets.length === 0) {
    const diagnostics = dedupe(configDiagnostics);
    if (pretty && diagnostics.length === 0) logger.warn('no Markdown files found');
    return reportDiagnostics(diagnostics, {
      cwd, format, color, strict: config.strict, logger, quiet: !pretty,
    });
  }

  const [{ parseMarkdown }, { validateDocument }, { renderHtml }] = await Promise.all([
    import('./markdown/parser.js'),
    import('./markdown/validate.js'),
    import('./markdown/renderer.js'),
  ]);

  /** @type {import('./markdown/diagnostics.js').Diagnostic[]} */
  const found = [...configDiagnostics];
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {string[]} */
  const checked = [];

  for (const abs of targets) {
    const file = relPosix(cwd, abs);
    checked.push(file);
    try {
      const { text, hadBom, hadCrlf } = readTextFile(abs);
      sources.set(file, text);

      // MD004/MD005 are properties of the *bytes*, which only the reader can see.
      const bag = createBag(file, { rules: config.rules });
      if (hadBom) {
        bag.add('MD005', { line: 1, column: 1 }, 'file starts with a UTF-8 byte order mark',
          'Re-save the file as UTF-8 without a BOM.');
      }
      if (hadCrlf) {
        bag.add('MD004', { line: 1, column: 1 }, 'file uses CRLF line endings',
          'Add `*.md text eol=lf` to .gitattributes and re-checkout.');
      }

      const parsed = parseMarkdown(text, { file, config });
      bag.absorb(parsed.diagnostics || []);
      bag.absorb(validateDocument(parsed.ast, { file, frontmatter: parsed.frontmatter, config }) || []);

      // Rendering surfaces the inline-level rules; it must never be able to fail the run.
      try {
        const rendered = renderHtml(parsed.ast, { file, config, slugRegistry: createSlugRegistry() });
        bag.absorb((rendered && rendered.diagnostics) || []);
      } catch {
        // A render crash is a bug, but `check` still has useful parse-level output.
      }

      found.push(...bag.list());
    } catch (err) {
      err.message = `while checking ${file}: ${err.message}`;
      throw err;
    }
  }

  // Route collisions and missing section indexes are properties of the tree, not of any one
  // file, so they only mean anything when the whole site is in scope. Without this, `check`
  // reports "no problems" on content that `build` rejects with NAV001 -- two commands
  // disagreeing about whether the same content is valid.
  if (!explicit) {
    try {
      const [{ scanContent }, { buildNav }] = await Promise.all([
        import('./content/scan.js'),
        import('./content/nav.js'),
      ]);
      const scanned = scanContent(cwd, config);
      found.push(...(scanned.diagnostics || []));
      const nav = buildNav(scanned.pages, scanned.meta, config);
      found.push(...(nav.diagnostics || []));
    } catch (err) {
      logger.warn(`site-level checks skipped: ${err.message}`);
    }
  }

  const diagnostics = dedupe(found);
  if (pretty) logger.dim(`checked ${checked.length} file${checked.length === 1 ? '' : 's'}`);
  return reportDiagnostics(diagnostics, {
    cwd, format, color, strict: config.strict, files: checked, sources, logger, quiet: !pretty,
  });
}

/**
 * `md2spa new <route>`
 * @param {{ cwd: string, flags: Record<string, string|boolean>, positionals: string[],
 *           logger: ReturnType<typeof createLogger> }} ctx
 * @returns {Promise<number>}
 */
async function cmdNew(ctx) {
  const { cwd, flags, positionals, logger } = ctx;
  const input = positionals[0];
  if (!input) {
    logger.error('missing <route>; try `md2spa new guide/install`');
    return EXIT.usage;
  }
  if (positionals.length > 1) {
    logger.error(`expected one route, got ${positionals.length}`);
    return EXIT.usage;
  }

  const raw = String(input).trim().replace(/\\/g, '/');
  const wantsIndex = raw.endsWith('/') || raw === '';
  const segments = raw
    .replace(MARKDOWN_RE, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.some((s) => s === '.' || s === '..')) {
    logger.error('route must not contain `.` or `..` segments');
    return EXIT.usage;
  }

  const { config } = await loadConfig(cwd, {
    configPath: typeof flags.config === 'string' ? flags.config : null,
  });
  const { contentDir } = resolveDirs(cwd, config);

  const parts = segments.slice();
  if (wantsIndex || parts.length === 0) parts.push('index');
  const relFile = `${parts.join('/')}.md`;
  const abs = path.join(contentDir, ...relFile.split('/'));

  if (pathExists(abs)) {
    logger.error(`${relPosix(cwd, abs)} already exists; refusing to overwrite it`);
    return EXIT.diagnostics;
  }

  const last = parts[parts.length - 1];
  const titleSource = last === 'index' ? parts[parts.length - 2] : last;
  const title = typeof flags.title === 'string' && flags.title
    ? flags.title
    : titleSource
      ? humanize(titleSource)
      : config.title;

  // Numeric ordering prefixes order the sidebar but never appear in the URL.
  const routeParts = parts.slice(0, last === 'index' ? -1 : undefined)
    .map((s) => s.replace(/^\d+[-_.]/, ''));
  const route = normalizeRoute(`/${routeParts.join('/')}/`);

  writeFileDeep(abs, [
    '---',
    `title: ${yamlScalar(title)}`,
    '---',
    '',
    `# ${title}`,
    '',
    'Write your content here.',
    '',
  ].join('\n'));

  logger.success(`created ${relPosix(cwd, abs)}`);
  logger.dim(`  route ${route}`);
  return EXIT.ok;
}

/**
 * `md2spa init`
 * @param {{ cwd: string, logger: ReturnType<typeof createLogger> }} ctx
 * @returns {Promise<number>}
 */
async function cmdInit(ctx) {
  const { cwd, logger } = ctx;
  const files = [
    ['md2spa.config.json', CONFIG_TEMPLATE],
    ['content/index.md', INDEX_TEMPLATE],
    ['content/guide/index.md', GUIDE_TEMPLATE],
  ];

  let written = 0;
  let skipped = 0;
  for (const [rel, content] of files) {
    const abs = path.join(cwd, ...rel.split('/'));
    if (pathExists(abs)) {
      logger.warn(`skip ${rel} (already exists)`);
      skipped += 1;
      continue;
    }
    writeFileDeep(abs, content);
    logger.success(`create ${rel}`);
    written += 1;
  }

  if (written === 0) {
    logger.info('');
    logger.dim(`nothing to do — all ${skipped} file(s) already exist`);
    return EXIT.ok;
  }

  logger.info('');
  logger.dim('Next steps');
  logger.dim('  md2spa dev                 preview with live reload');
  logger.dim('  md2spa new guide/install   add a page');
  logger.dim('  md2spa build --out public  build for GitLab Pages');
  return EXIT.ok;
}

/** Where the bundled deployment recipes live. */
const TEMPLATE_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/**
 * One-line descriptions for `md2spa template` with no argument. Keyed by directory name
 * under `templates/`; a directory with no entry here still works, it just lists untitled.
 */
const TEMPLATE_SUMMARIES = {
  gitlab: 'GitLab Pages -- lint job with a JUnit report, plus a pages job',
  github: 'GitHub Pages -- Actions workflow with PR annotations, plus .nojekyll',
  server: 'Self-hosted -- multi-stage Dockerfile, nginx config and compose file',
};

/**
 * Available targets, discovered from the filesystem so adding a directory is enough.
 * @returns {string[]}
 */
function availableTemplates() {
  if (!isDirectory(TEMPLATE_DIR)) return [];
  return fs.readdirSync(TEMPLATE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * `md2spa template [target]`
 * @param {{ cwd: string, flags: Record<string, string|boolean>, positionals: string[],
 *           logger: ReturnType<typeof createLogger> }} ctx
 * @returns {Promise<number>}
 */
async function cmdTemplate(ctx) {
  const { cwd, flags, positionals, logger } = ctx;
  const targets = availableTemplates();

  if (targets.length === 0) {
    logger.error(`no templates found at ${TEMPLATE_DIR}`);
    logger.dim('  reinstall md2spa, or check that templates/ was published intact');
    return EXIT.internal;
  }

  const target = positionals[0];

  if (!target || flags.list === true) {
    logger.info('Available deployment targets\n');
    for (const name of targets) {
      const summary = TEMPLATE_SUMMARIES[name] || '';
      process.stdout.write(`  ${name.padEnd(10)}${summary}\n`);
    }
    logger.info('');
    logger.dim('  md2spa template <target>     add the files for one of these');
    logger.dim('  md2spa template <target> --force   overwrite what is already there');
    return EXIT.ok;
  }

  if (!targets.includes(target)) {
    logger.error(`unknown target \`${target}\``);
    logger.dim(`  available: ${targets.join(', ')}`);
    return EXIT.usage;
  }

  const from = path.join(TEMPLATE_DIR, target);
  // walkDir keeps dotfiles, which matters: `.gitlab-ci.yml`, `.nojekyll` and
  // `.dockerignore` are the whole point of two of these templates.
  const entries = walkDir(from);
  if (entries.length === 0) {
    logger.error(`template \`${target}\` is empty`);
    return EXIT.internal;
  }

  let written = 0;
  let skipped = 0;
  for (const rel of entries) {
    const dest = path.join(cwd, ...rel.split('/'));
    if (pathExists(dest) && flags.force !== true) {
      logger.warn(`skip ${rel} (already exists)`);
      skipped += 1;
      continue;
    }
    writeFileDeep(dest, fs.readFileSync(path.join(from, ...rel.split('/'))));
    logger.success(`${pathExists(dest) && flags.force === true ? 'write' : 'create'} ${rel}`);
    written += 1;
  }

  if (written === 0) {
    logger.info('');
    logger.dim(`nothing to do -- all ${skipped} file(s) already exist (use --force to overwrite)`);
    return EXIT.ok;
  }

  logger.info('');
  for (const line of (TEMPLATE_NEXT_STEPS[target] || [])) logger.dim(line);
  return EXIT.ok;
}

/** Printed after a template is written, so the next move is never a guess. */
const TEMPLATE_NEXT_STEPS = {
  gitlab: [
    'Next steps',
    '  git add .gitlab-ci.yml && git commit -m "Add GitLab Pages pipeline"',
    '  git push                              the pages job runs on your default branch',
    '',
    '  Your site: https://<namespace>.gitlab.io/<project>/',
    '  No `base` setting is needed -- `base: "auto"` handles the /<project>/ prefix.',
  ],
  github: [
    'Next steps',
    '  git add .github static/.nojekyll && git commit -m "Add GitHub Pages workflow"',
    '  git push',
    '  Settings -> Pages -> Build and deployment -> Source: "GitHub Actions"',
    '',
    '  Your site: https://<user>.github.io/<repo>/',
  ],
  server: [
    'Next steps',
    '  docker compose up --build -d          serve on http://localhost:8080',
    '  docker compose logs -f                follow the access log',
    '',
    '  The site is baked into the image, so redeploying is a rebuild.',
  ],
};

/**
 * The rule catalogue, for `md2spa check --list-rules`.
 * @param {boolean} color
 * @returns {string}
 */
export function formatRuleTable(color) {
  const paint = createLogger({ color }).paint;
  const tint = { error: 'red', warning: 'yellow', info: 'blue' };
  const codes = Object.keys(RULES).sort();
  const width = codes.reduce((max, code) => Math.max(max, code.length), 0);
  const lines = codes.map((code) => {
    const rule = RULES[code];
    return `  ${paint('bold', code.padEnd(width))}  ${paint(tint[rule.severity], rule.severity.padEnd(7))}  ${rule.title}`;
  });
  return [
    `${codes.length} rules (code, default severity, title)`,
    '',
    ...lines,
    '',
    'Override any of them in your config:',
    '  "rules": { "MD047": "off", "MD013": "error" }',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Scaffolding templates (kept byte-stable so `init` is reproducible)
// ---------------------------------------------------------------------------------------

const CONFIG_TEMPLATE = `${JSON.stringify({
  title: 'My Docs',
  description: 'Documentation for my project',
  base: 'auto',
  contentDir: 'content',
  outDir: 'dist',
  staticDir: 'static',
  cleanUrls: true,
  spa: true,
  search: true,
  theme: { accent: '#5b5bd6', defaultMode: 'auto' },
  repo: { url: '', label: '' },
}, null, 2)}\n`;

const INDEX_TEMPLATE = `---
title: Home
description: Start here.
---

# My Docs

Welcome. Every Markdown file under \`content/\` becomes a page, and the folder tree
becomes the navigation — drop in a new \`.md\` file and it shows up in the sidebar
with no configuration at all.

## Getting started

- Run \`md2spa dev\` and edit this file; the browser reloads on save.
- Add a page with \`md2spa new guide/install\`.
- Build for deployment with \`md2spa build --out public\`.

> [!TIP]
> The default \`base: "auto"\` emits document-relative URLs, so the same build works
> at the site root, under \`/user/project/\` on GitLab or GitHub Pages, and offline.
`;

const GUIDE_TEMPLATE = `---
title: Guide
order: 1
---

# Guide

This folder is a navigation group. Files beside this one become its children:
\`content/guide/install.md\` is served at \`/guide/install/\`.

| Feature            | Status |
| ------------------ | ------ |
| Zero-config nav    | yes    |
| Live reload        | yes    |
| Client-side search | yes    |

!!! note "Optional metadata"
    Add a \`_meta.json\` next to these files to override the group title, ordering
    or icon. Every key is optional.
`;

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * Read the version out of package.json without an import assertion (Node 18 compatible).
 * @returns {string}
 */
export function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * Levenshtein distance, used only for `did you mean` suggestions.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const row = [i];
    for (let j = 1; j < cols; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[cols - 1];
}

/**
 * Run the CLI.
 * @param {string[]} argv arguments after the executable and script
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  const color = argv.includes('--no-color') ? false : supportsColor();
  const logger = createLogger({ color });
  const cwd = process.cwd();

  const first = argv[0];

  if (first === undefined) {
    process.stdout.write(`${mainHelp()}\n`);
    return EXIT.usage;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    const topic = argv[1];
    if (topic && COMMANDS[topic]) {
      process.stdout.write(`${commandHelp(topic)}\n`);
      return EXIT.ok;
    }
    process.stdout.write(`${mainHelp()}\n`);
    return EXIT.ok;
  }
  if (first === '--version' || first === '-v' || first === '-V') {
    process.stdout.write(`md2spa ${readVersion()}\n`);
    return EXIT.ok;
  }
  if (first.startsWith('-')) {
    logger.error(`unknown option \`${first}\`; a command must come first`);
    logger.dim('Run `md2spa --help` to see the available commands.');
    return EXIT.usage;
  }

  const command = COMMANDS[first];
  if (!command) {
    const near = Object.keys(COMMANDS)
      .map((name) => ({ name, d: distance(first, name) }))
      .sort((a, b) => a.d - b.d)[0];
    logger.error(`unknown command \`${first}\``);
    if (near && near.d <= 3) logger.dim(`Did you mean \`md2spa ${near.name}\`?`);
    logger.dim('Run `md2spa --help` to see the available commands.');
    return EXIT.usage;
  }

  const spec = { ...GLOBAL_FLAGS, ...command.flags };
  const { flags, positionals, errors } = parseArgs(argv.slice(1), spec);

  if (flags.help === true) {
    process.stdout.write(`${commandHelp(first)}\n`);
    return EXIT.ok;
  }
  if (flags.version === true) {
    process.stdout.write(`md2spa ${readVersion()}\n`);
    return EXIT.ok;
  }
  if (errors.length > 0) {
    for (const message of errors) logger.error(message);
    logger.dim(`Run \`md2spa ${first} --help\` for the accepted options.`);
    return EXIT.usage;
  }

  const useColor = flags.color === false ? false : color;
  return command.run({
    cwd,
    flags,
    positionals,
    logger: useColor === color ? logger : createLogger({ color: useColor }),
    color: useColor,
  });
}

/**
 * Wrap `main` so nothing ever escapes as an unhandled rejection.
 * @returns {void}
 */
function run() {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = typeof code === 'number' ? code : EXIT.ok;
    },
    (err) => {
      const message = err && err.message ? err.message : String(err);
      const color = !process.argv.includes('--no-color') && supportsColor(process.stderr);
      const logger = createLogger({ color });
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        logger.error(`this md2spa installation is incomplete: ${message}`);
        process.stderr.write('      reinstall md2spa, or check that src/ was published intact\n');
      } else {
        logger.error(`internal error: ${message}`);
      }
      if (process.argv.includes('--stack') && err && err.stack) {
        process.stderr.write(`${err.stack}\n`);
      } else {
        process.stderr.write('      run the same command with --stack for a full stack trace\n');
      }
      process.exitCode = EXIT.internal;
    },
  );
}

// Only take over the process when invoked as the binary; importing this module (for tests)
// must have no side effects.
const invokedPath = process.argv[1];
if (invokedPath) {
  let entry = null;
  try {
    entry = pathToFileURL(fs.realpathSync(invokedPath)).href;
  } catch {
    entry = pathToFileURL(invokedPath).href;
  }
  if (entry === import.meta.url) run();
}
