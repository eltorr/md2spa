/**
 * Well-formedness verification of *emitted* HTML.
 *
 * This is the guarantee behind "a standardized format for html": nothing leaves the build
 * without a doctype, a language, a title, a viewport, balanced tags, unique ids, alt text
 * on every image and zero inline event handlers. It runs over every document the build
 * writes, so a renderer regression surfaces as a diagnostic instead of as a broken site.
 *
 * The scanner is a single linear pass -- no backtracking regex touches the document body,
 * and every branch provably advances the cursor, so a pathological input cannot hang it.
 *
 * @module build/verify
 */

import { createBag } from '../markdown/diagnostics.js';
import { VOID_TAGS } from '../util/html.js';

/** Marks an inline `<script>` the build itself emitted and vouches for. */
export const INLINE_SCRIPT_ATTR = 'data-md2spa-inline';

/**
 * 404.html emits empty `<script data-md2spa-asset="…">` placeholders that the runtime
 * base bootstrap replaces with a real module script; they carry no code of their own.
 */
const ASSET_SCRIPT_ATTR = 'data-md2spa-asset';

/** `type` values that mean "this script element is data, not code". */
const DATA_SCRIPT_TYPES = new Set([
  'application/json', 'application/ld+json', 'text/template', 'text/html',
  'text/x-template', 'importmap', 'speculationrules',
]);

/** Elements whose content is raw text and must not be tokenised as markup. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** Elements that browsers close implicitly, so an unclosed one is not a defect. */
const OPTIONAL_END_TAGS = new Set([
  'li', 'dt', 'dd', 'p', 'option', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'rt', 'rp',
]);

/** Beyond this we stop reporting: the document is broken enough already. */
const MAX_FINDINGS = 50;

const ATTR_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Build an offset -> {line, column} lookup with a single pass over the source.
 * @param {string} text
 * @returns {(offset: number) => { line: number, column: number }}
 */
function createLocator(text) {
  /** @type {number[]} */
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset) => {
    const target = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: target - starts[lo] + 1 };
  };
}

/**
 * Parse an attribute list into a lowercase-keyed map, preserving value case.
 * @param {string} source
 * @returns {Map<string, string|true>}
 */
function parseAttributes(source) {
  /** @type {Map<string, string|true>} */
  const map = new Map();
  if (!source || !source.trim()) return map;
  ATTR_PATTERN.lastIndex = 0;
  let match;
  let guard = 0;
  while ((match = ATTR_PATTERN.exec(source)) !== null) {
    // ATTR_PATTERN can match empty at a stuck position; force progress.
    if (match[0] === '') {
      ATTR_PATTERN.lastIndex += 1;
      if (ATTR_PATTERN.lastIndex > source.length) break;
      continue;
    }
    const name = match[1].toLowerCase();
    const hasValue = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined;
    if (!map.has(name)) map.set(name, hasValue ? (match[2] ?? match[3] ?? match[4] ?? '') : true);
    guard += 1;
    if (guard > 512) break;
  }
  return map;
}

/**
 * Verify one emitted document.
 *
 * @param {string} html the complete document
 * @param {string} file path used in the diagnostics, POSIX, relative to cwd
 * @param {{ rules?: Record<string, string> }} [options]
 * @returns {import('../markdown/diagnostics.js').Diagnostic[]}
 */
export function verifyHtml(html, file, options = {}) {
  const source = String(html ?? '');
  const bag = createBag(file, { rules: options.rules || {} });
  const locate = createLocator(source);
  let findings = 0;

  /**
   * @param {number} offset
   * @param {string} message
   * @param {string|null} [hint]
   */
  const report = (offset, message, hint = null) => {
    if (findings >= MAX_FINDINGS) return;
    findings += 1;
    const { line, column } = locate(offset);
    bag.add('HTM001', { line, column, endColumn: column + 1 }, message, hint);
  };

  if (source.trim() === '') {
    report(0, 'generated document is empty');
    return bag.list();
  }

  const lower = source.toLowerCase();

  // --- document-level facts collected during the scan -------------------------------
  let hasDoctype = false;
  let htmlSeen = false;
  let htmlHasLang = false;
  let headCount = 0;
  let bodyCount = 0;
  let titleCount = 0;
  let titleText = '';
  let hasViewport = false;

  /** @type {Map<string, number>} */
  const ids = new Map();
  /** @type {Array<{ tag: string, offset: number }>} */
  const stack = [];

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    let next = lt + 1;

    if (lower.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (lower.startsWith('<![cdata[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const gt = source.indexOf('>', lt);
      if (lower.startsWith('<!doctype', lt)) {
        if (!/^<!doctype\s+html\s*>/i.test(source.slice(lt, gt === -1 ? source.length : gt + 1))) {
          report(lt, 'doctype must be exactly `<!doctype html>`');
        }
        // Anything before the doctype other than whitespace is a defect of its own.
        if (!hasDoctype && source.slice(0, lt).trim() !== '') {
          report(0, 'content appears before the doctype declaration');
        }
        hasDoctype = true;
      }
      i = gt === -1 ? source.length : gt + 1;
      continue;
    }

    if (source.startsWith('</', lt)) {
      const gt = source.indexOf('>', lt);
      if (gt === -1) { report(lt, 'unterminated closing tag'); break; }
      const name = lower.slice(lt + 2, gt).trim();
      if (!/^[a-z][a-z0-9-]*$/.test(name)) { i = gt + 1; continue; }

      if (VOID_TAGS.has(name)) {
        report(lt, `<${name}> is a void element and must not have a closing tag`,
          `Remove </${name}>.`);
      } else {
        const idx = (() => {
          for (let s = stack.length - 1; s >= 0; s -= 1) if (stack[s].tag === name) return s;
          return -1;
        })();
        if (idx === -1) {
          report(lt, `closing tag </${name}> has no matching opening tag`);
        } else {
          for (let s = stack.length - 1; s > idx; s -= 1) {
            if (!OPTIONAL_END_TAGS.has(stack[s].tag)) {
              report(stack[s].offset, `<${stack[s].tag}> is never closed`,
                `Add </${stack[s].tag}> before </${name}>.`);
            }
          }
          stack.length = idx;
        }
      }
      i = gt + 1;
      continue;
    }

    // Not a tag start (`a < b` in text) -- step over the `<` and carry on.
    if (!/[a-zA-Z]/.test(source[next] || '')) { i = next; continue; }

    const gt = source.indexOf('>', lt);
    if (gt === -1) { report(lt, 'unterminated tag'); break; }

    let nameEnd = lt + 1;
    while (nameEnd < gt && /[a-zA-Z0-9-]/.test(source[nameEnd])) nameEnd += 1;
    const tag = lower.slice(lt + 1, nameEnd);
    const rawAttrs = source.slice(nameEnd, gt);
    const selfClosing = rawAttrs.trimEnd().endsWith('/');
    const attrSource = selfClosing ? rawAttrs.trimEnd().slice(0, -1) : rawAttrs;
    const attributes = parseAttributes(attrSource);
    i = gt + 1;

    for (const [name, value] of attributes) {
      if (/^on[a-z]/.test(name)) {
        report(lt, `inline event handler \`${name}\` on <${tag}>`,
          'Event handlers must live in app.js so the output survives a strict CSP.');
      }
      if (name === 'id') {
        const id = typeof value === 'string' ? value : '';
        if (id === '') {
          report(lt, `<${tag}> has an empty id attribute`);
        } else if (ids.has(id)) {
          report(lt, `duplicate id "${id}"`,
            'Ids must be unique; heading slugs are de-duplicated automatically (MD014).');
        } else {
          ids.set(id, lt);
        }
      }
    }

    switch (tag) {
      case 'html':
        htmlSeen = true;
        if (typeof attributes.get('lang') === 'string' && attributes.get('lang') !== '') {
          htmlHasLang = true;
        }
        break;
      case 'head': headCount += 1; break;
      case 'body': bodyCount += 1; break;
      case 'title': titleCount += 1; break;
      case 'meta':
        if (String(attributes.get('name') ?? '').toLowerCase() === 'viewport') hasViewport = true;
        break;
      case 'img':
        if (!attributes.has('alt')) {
          report(lt, '<img> is missing an alt attribute',
            'Use alt="" for decorative images so screen readers skip them.');
        }
        break;
      case 'script': {
        const type = String(attributes.get('type') ?? '').toLowerCase().trim();
        const isData = DATA_SCRIPT_TYPES.has(type);
        if (!attributes.has('src') && !attributes.has(INLINE_SCRIPT_ATTR)
          && !attributes.has(ASSET_SCRIPT_ATTR) && !isData) {
          report(lt, 'inline <script> without a src or the build\'s inline marker',
            `Load it from a file, or mark a build-emitted snippet with ${INLINE_SCRIPT_ATTR}.`);
        }
        break;
      }
      default: break;
    }

    // Raw-text elements: their content is not markup at all, so skip the whole element
    // rather than tokenising a `<` that appears inside a script or a title.
    if (RAW_TEXT_TAGS.has(tag) && !selfClosing && !VOID_TAGS.has(tag)) {
      const close = lower.indexOf(`</${tag}`, i);
      if (tag === 'title' && titleCount === 1) {
        titleText = close === -1 ? source.slice(i) : source.slice(i, close);
      }
      if (close === -1) {
        report(lt, `<${tag}> is never closed`);
        i = source.length;
      } else {
        const closeEnd = source.indexOf('>', close);
        i = closeEnd === -1 ? source.length : closeEnd + 1;
      }
      continue;
    }

    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push({ tag, offset: lt });
  }

  for (let s = stack.length - 1; s >= 0; s -= 1) {
    if (!OPTIONAL_END_TAGS.has(stack[s].tag)) {
      report(stack[s].offset, `<${stack[s].tag}> is never closed`,
        `Add a matching </${stack[s].tag}>.`);
    }
  }

  if (!hasDoctype) report(0, 'document is missing `<!doctype html>`');
  if (!htmlSeen) report(0, 'document has no <html> element');
  else if (!htmlHasLang) {
    report(0, '<html> is missing a lang attribute',
      'Set `lang` in md2spa.config.json.');
  }
  if (headCount !== 1) report(0, `document must contain exactly one <head>, found ${headCount}`);
  if (bodyCount !== 1) report(0, `document must contain exactly one <body>, found ${bodyCount}`);
  if (titleCount === 0) report(0, 'document has no <title>');
  else if (titleText.trim() === '') report(0, '<title> is empty');
  if (!hasViewport) {
    report(0, 'document is missing the viewport meta tag',
      'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  }

  return bag.list();
}
