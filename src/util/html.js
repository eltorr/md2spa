/**
 * HTML escaping and raw-HTML sanitisation.
 *
 * Markdown is frequently authored by many hands, so raw HTML passing through the
 * pipeline is treated as untrusted. The policy is deliberately three-way (see SPEC.md
 * "Raw-HTML policy"):
 *
 *   1. tag is in ALLOWED_TAGS         -> kept, attributes filtered
 *   2. tag is real HTML but unsafe    -> escaped AND reported (MD052)
 *   3. tag is not a known HTML element-> escaped silently
 *
 * Rule 3 matters: technical docs are full of placeholders like `<your-volume>` and
 * inline XML like `<key>`. Warning about those would drown the real findings.
 *
 * @module util/html
 */

/** Tags that survive sanitisation. */
export const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/** Real HTML elements that must never survive -- escaping these is a finding. */
export const UNSAFE_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'fieldset',
  'link', 'meta', 'base', 'title', 'head', 'body', 'html', 'svg', 'math', 'template',
  'slot', 'noscript', 'marquee', 'audio', 'video', 'canvas', 'dialog', 'portal',
]);

/**
 * Every element name the HTML spec knows about. Used only to decide between
 * "escape and warn" and "escape silently".
 */
export const KNOWN_HTML_ELEMENTS = new Set([
  ...ALLOWED_TAGS, ...UNSAFE_TAGS,
  'address', 'area', 'article', 'aside', 'data', 'datalist', 'dir', 'element',
  'fencedframe', 'figcaption', 'font', 'footer', 'header', 'hgroup', 'iframe', 'image',
  'legend', 'main', 'map', 'menu', 'meter', 'nav', 'nobr', 'optgroup', 'output',
  'param', 'plaintext', 'progress', 'rb', 'rp', 'rt', 'rtc', 'ruby', 'search',
  'section', 'shadow', 'strike', 'track', 'tt', 'xmp',
]);

/** Elements that never have a closing tag. */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir', 'role', 'translate']);

/** Attributes allowed on specific elements. */
const TAG_ATTRS = {
  a: ['href', 'target', 'rel', 'download', 'hreflang', 'type', 'name'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes', 'referrerpolicy'],
  source: ['src', 'srcset', 'sizes', 'type', 'media', 'width', 'height'],
  td: ['colspan', 'rowspan', 'headers', 'abbr'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  details: ['open', 'name'],
  time: ['datetime'],
  q: ['cite'],
  blockquote: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  bdo: ['dir'],
  pre: ['tabindex'],
};

/** Attributes whose value is a URL and therefore needs scheme validation. */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'cite', 'action', 'formaction', 'data']);

/** Schemes that are safe to link to. */
const SAFE_SCHEMES = /^(https?|mailto|tel|sms|irc|ircs|ftp|ftps|matrix|xmpp|magnet|news|feed|git|ssh|steam|geo|bitcoin|callto|webcal):/i;

/** Data URIs limited to raster images -- `data:image/svg+xml` is a script vector. */
const SAFE_DATA_URI = /^data:image\/(png|gif|jpe?g|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i;

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for use in HTML body content.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Escape text for use inside a double-quoted attribute value.
 * @param {string} text
 * @returns {string}
 */
export function escapeAttr(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Named character references that authors of technical documentation actually reach for.
 *
 * The list is a deliberate allowlist rather than a shape test. HTML5 keeps ~106 "legacy"
 * references valid *without* a trailing semicolon, and browsers match them greedily, so
 * anything matching the general `&name;` shape is not safe to wave through: `&notanentity;`
 * is parsed as `&not` + `anentity;` and silently renders as `¬anentity;`. Escaping the
 * ampersand instead shows the author exactly what they typed.
 *
 * A valid reference outside this set renders literally too. That is a visible, obvious
 * outcome with an obvious fix (use the numeric form, `&#8243;`), which is a much better
 * failure than a paragraph that quietly says something else.
 */
const NAMED_ENTITIES = new Set([
  // Core / mandatory
  'amp', 'lt', 'gt', 'quot', 'apos', 'nbsp',
  // Punctuation and typography
  'ndash', 'mdash', 'horbar', 'hellip', 'lsquo', 'rsquo', 'sbquo', 'ldquo', 'rdquo',
  'bdquo', 'dagger', 'Dagger', 'bull', 'middot', 'permil', 'prime', 'Prime', 'lsaquo',
  'rsaquo', 'laquo', 'raquo', 'oline', 'frasl', 'shy', 'ensp', 'emsp', 'thinsp', 'zwj',
  'zwnj', 'lrm', 'rlm', 'para', 'sect', 'brvbar', 'iexcl', 'iquest', 'sol', 'commat',
  'lowbar', 'num', 'excl', 'ast', 'quest', 'semi', 'colon', 'comma', 'period', 'dollar',
  'lpar', 'rpar', 'lbrack', 'rbrack', 'lbrace', 'rbrace', 'verbar', 'bsol', 'grave',
  'circ', 'tilde', 'macr', 'acute', 'cedil', 'uml', 'diams', 'clubs', 'hearts', 'spades',
  // Currency and legal
  'copy', 'reg', 'trade', 'cent', 'pound', 'curren', 'yen', 'euro', 'fnof', 'deg',
  // Maths and logic
  'plusmn', 'times', 'divide', 'minus', 'lowast', 'radic', 'prop', 'infin', 'ang',
  'and', 'or', 'cap', 'cup', 'int', 'there4', 'sim', 'cong', 'asymp', 'ne', 'equiv',
  'le', 'ge', 'sub', 'sup', 'nsub', 'sube', 'supe', 'oplus', 'otimes', 'perp', 'sdot',
  'sum', 'prod', 'part', 'nabla', 'isin', 'notin', 'ni', 'exist', 'forall', 'empty',
  'weierp', 'image', 'real', 'alefsym', 'frac12', 'frac14', 'frac34', 'sup1', 'sup2',
  'sup3', 'micro', 'ordf', 'ordm', 'not',
  // Arrows
  'larr', 'uarr', 'rarr', 'darr', 'harr', 'crarr', 'lArr', 'uArr', 'rArr', 'dArr',
  'hArr', 'loz',
  // Greek
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
  'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi',
  'Chi', 'Psi', 'Omega', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta',
  'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigmaf',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'thetasym', 'upsih', 'piv',
  // Latin-1 letters
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil', 'Egrave',
  'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml', 'ETH', 'Ntilde',
  'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'Oslash', 'Ugrave', 'Uacute', 'Ucirc',
  'Uuml', 'Yacute', 'THORN', 'szlig', 'agrave', 'aacute', 'acirc', 'atilde', 'auml',
  'aring', 'aelig', 'ccedil', 'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute',
  'icirc', 'iuml', 'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml',
  'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml', 'OElig',
  'oelig', 'Scaron', 'scaron', 'Yuml',
]);

/**
 * True when `&{name};` is a character reference we are willing to emit unescaped.
 * @param {string} name
 * @returns {boolean}
 */
function isKnownEntity(name) {
  if (name.charAt(0) === '#') {
    return /^#\d{1,7}$/.test(name) || /^#[xX][0-9a-fA-F]{1,6}$/.test(name);
  }
  return NAMED_ENTITIES.has(name);
}

/**
 * Escape `&` unless it opens a character reference we recognise. Lets authored entities
 * such as `&copy;` and `&#8212;` survive while neutralising both stray ampersands and
 * misspelled references that a browser would otherwise reinterpret.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtmlPreservingEntities(text) {
  return String(text)
    .replace(/&(#?[a-zA-Z0-9]{1,32});/g, (match, name) => (isKnownEntity(name) ? match : `&amp;${name};`))
    .replace(/&(?![a-zA-Z0-9#]{1,32};)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Decide whether a URL is safe to emit.
 *
 * Control characters are stripped first: `java\tscript:alert(1)` is a real bypass that
 * browsers normalise back into `javascript:`.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  const cleaned = String(url).replace(/[\u0000-\u0020\u007F-\u009F]/g, '');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned)) {
    if (SAFE_SCHEMES.test(cleaned)) return true;
    if (SAFE_DATA_URI.test(cleaned)) return true;
    return false;
  }
  // Relative paths, fragments, query-only and protocol-relative URLs.
  return true;
}

/**
 * Sanitise a URL for output, returning `''` when it must be dropped.
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrl(url) {
  return isSafeUrl(url) ? String(url).trim() : '';
}

const ATTR_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * @param {string} tag
 * @param {string} attrSource
 * @param {(code: string, message: string, hint: string|null) => void} report
 * @returns {string} the rebuilt, filtered attribute string (leading space included)
 */
function filterAttributes(tag, attrSource, report) {
  if (!attrSource || !attrSource.trim()) return '';
  const allowed = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] || [])]);
  const parts = [];
  ATTR_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTR_PATTERN.exec(attrSource)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';

    if (name.startsWith('on')) {
      report('MD052', `event handler attribute \`${name}\` removed from <${tag}>`,
        'Inline event handlers are never emitted. Use the theme\'s JavaScript instead.');
      continue;
    }
    if (name === 'style') {
      report('MD052', `\`style\` attribute removed from <${tag}>`,
        'Add a class and style it in your CSS, or use a supported attribute.');
      continue;
    }

    const isAria = name.startsWith('aria-');
    const isData = name.startsWith('data-');
    if (!allowed.has(name) && !isAria && !isData) {
      report('MD052', `attribute \`${name}\` is not permitted on <${tag}>`, null);
      continue;
    }

    if (URL_ATTRS.has(name) && !isSafeUrl(value)) {
      report('MD052', `unsafe URL removed from \`${name}\` on <${tag}>`,
        'Only http(s), mailto, tel and raster data: URLs are allowed.');
      continue;
    }

    parts.push(match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
      ? `${name}="${escapeAttr(value)}"`
      : name);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

const TOKEN_PATTERN = new RegExp(
  [
    '<!--[\\s\\S]*?-->',                                    // comment
    '<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',                       // CDATA
    '<![^>]*>',                                             // doctype / bogus
    '<\\?[\\s\\S]*?\\?>',                                   // processing instruction
    '</\\s*([a-zA-Z][a-zA-Z0-9-]*)\\s*>',                   // close tag
    '<\\s*([a-zA-Z][a-zA-Z0-9-]*)((?:\\s+[^\\s"\'>/=]+(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?)*)\\s*(/?)\\s*>', // open tag
  ].join('|'),
  'g',
);

/**
 * Sanitise a raw HTML fragment coming from Markdown source.
 *
 * Markdown hands raw HTML to the renderer one *token* at a time: `<kbd>Ctrl</kbd>` arrives
 * as an html node, a text node and a second html node. Balance therefore cannot be judged
 * per call. Pass `options.stack` (a caller-owned array) to thread the open-element stack
 * across calls; the caller then finishes with {@link closeDanglingTags}. Without a stack the
 * fragment is treated as self-contained and closed at the end, as before.
 *
 * @param {string} raw
 * @param {{ stack?: string[] }} [options]
 * @returns {{ html: string, issues: Array<{ code: string, message: string, hint: string|null, offset: number }> }}
 */
export function sanitizeRawHtml(raw, options = {}) {
  const input = String(raw);
  /** @type {Array<{ code: string, message: string, hint: string|null, offset: number }>} */
  const issues = [];
  /** @type {string[]} */
  const out = [];
  const carried = Array.isArray(options.stack);
  /** @type {string[]} */
  const openStack = carried ? options.stack : [];

  let cursor = 0;
  let match;
  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(input)) !== null) {
    const token = match[0];
    const offset = match.index;
    if (offset > cursor) out.push(escapeHtmlPreservingEntities(input.slice(cursor, offset)));
    cursor = offset + token.length;

    const report = (code, message, hint) => issues.push({ code, message, hint, offset });

    // Comments, CDATA, doctypes and PIs are dropped entirely.
    if (token.startsWith('<!') || token.startsWith('<?')) continue;

    const closeTag = match[1];
    const openTag = match[2];

    if (closeTag) {
      const tag = closeTag.toLowerCase();
      if (ALLOWED_TAGS.has(tag) && !VOID_TAGS.has(tag)) {
        const idx = openStack.lastIndexOf(tag);
        if (idx === -1) {
          report('MD051', `closing tag </${tag}> has no matching opening tag`,
            `Remove it, or add a <${tag}> before it.`);
          continue;
        }
        // Unwind: anything still open inside `tag` has to be closed first, or the
        // emitted document stops being well-formed.
        for (let i = openStack.length - 1; i > idx; i -= 1) {
          report('MD051', `unclosed HTML tag <${openStack[i]}>`,
            `Add a matching </${openStack[i]}>.`);
          out.push(`</${openStack[i]}>`);
        }
        openStack.length = idx;
        out.push(`</${tag}>`);
      } else if (KNOWN_HTML_ELEMENTS.has(tag)) {
        report('MD052', `raw HTML tag </${tag}> is not allowed and was escaped`, null);
        out.push(escapeHtml(token));
      } else {
        out.push(escapeHtml(token));
      }
      continue;
    }

    if (openTag) {
      const tag = openTag.toLowerCase();
      const attrSource = match[3] || '';
      const selfClosing = match[4] === '/';

      if (ALLOWED_TAGS.has(tag)) {
        const attrs = filterAttributes(tag, attrSource, report);
        if (VOID_TAGS.has(tag)) {
          out.push(`<${tag}${attrs}>`);
        } else if (selfClosing) {
          out.push(`<${tag}${attrs}></${tag}>`);
        } else {
          openStack.push(tag);
          out.push(`<${tag}${attrs}>`);
        }
      } else if (KNOWN_HTML_ELEMENTS.has(tag)) {
        report('MD052', `raw HTML tag <${tag}> is not allowed and was escaped`,
          UNSAFE_TAGS.has(tag)
            ? `<${tag}> can execute code or capture input, so it is never emitted.`
            : null);
        out.push(escapeHtml(token));
      } else {
        // Placeholder like <your-volume>, or inline XML like <key>. Literal text.
        out.push(escapeHtml(token));
      }
    }
  }

  if (cursor < input.length) out.push(escapeHtmlPreservingEntities(input.slice(cursor)));

  // Close anything the author left dangling so the document stays well-formed. When the
  // caller owns the stack it decides when the stream ends, so leave it alone here.
  if (!carried) {
    const tail = closeDanglingTags(openStack, input.length);
    out.push(tail.html);
    issues.push(...tail.issues);
  }

  return { html: out.join(''), issues };
}

/**
 * Emit closing tags for everything left on a carried {@link sanitizeRawHtml} stack and
 * report each one as `MD051`. Empties the stack.
 *
 * @param {string[]} stack open-element stack, innermost last
 * @param {number} [offset] source offset to attribute the diagnostics to
 * @returns {{ html: string, issues: Array<{ code: string, message: string, hint: string|null, offset: number }> }}
 */
export function closeDanglingTags(stack, offset = 0) {
  /** @type {Array<{ code: string, message: string, hint: string|null, offset: number }>} */
  const issues = [];
  const out = [];
  if (!Array.isArray(stack)) return { html: '', issues };
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    issues.push({
      code: 'MD051',
      message: `unclosed HTML tag <${stack[i]}>`,
      hint: `Add a matching </${stack[i]}>.`,
      offset,
    });
    out.push(`</${stack[i]}>`);
  }
  stack.length = 0;
  return { html: out.join(''), issues };
}

/**
 * Render an attribute map to a string, skipping null/undefined/false values.
 * @param {Record<string, string|number|boolean|null|undefined>} attrs
 * @returns {string} leading space included when non-empty
 */
export function attrs(attrs_) {
  const parts = [];
  for (const [name, value] of Object.entries(attrs_)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) parts.push(name);
    else parts.push(`${name}="${escapeAttr(value)}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}
