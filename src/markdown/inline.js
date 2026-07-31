/**
 * The inline scanner.
 *
 * Turns the text of one leaf block into `Inline[]`. Two phases, as CommonMark
 * prescribes: a left-to-right scan that emits nodes and records emphasis delimiter
 * runs, then a delimiter-matching pass that folds those runs into `strong` /
 * `emphasis` / `delete` nodes.
 *
 * Every node -- and every diagnostic -- carries an exact 1-based line/column resolved
 * from a character offset. That accuracy is the whole point: a linter that points at
 * the wrong column is a linter nobody trusts. Callers hand us the source column of each
 * line of `text` via `columns`, which is how positions survive being nested inside
 * blockquotes and list items.
 *
 * @module markdown/inline
 */

/** ASCII punctuation, per CommonMark's definition of an escapable character. */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/;

/** Unicode punctuation, used by the flanking rules. */
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

const AUTOLINK_URI = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\u0000-\u0020<>]*)>/;
const AUTOLINK_EMAIL = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;

/**
 * A raw HTML tag. The attribute loop is safe from catastrophic backtracking because
 * `\s+` and `[^\s"'>/=]+` match disjoint character sets, so there is only one way to
 * split any input.
 */
const HTML_TAG = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/;
const HTML_COMMENT = /^<!--[\s\S]*?-->/;
const HTML_PI = /^<\?[\s\S]*?\?>/;
const HTML_DECL = /^<![A-Za-z][^>]*>/;
const HTML_CDATA = /^<!\[CDATA\[[\s\S]*?\]\]>/;

/** A bare URL worth linkifying. Trailing punctuation is trimmed afterwards. */
const BARE_URL = /^(?:https?:\/\/|www\.)[^\u0000-\u0020<>"'`]+/;

/** Characters that may precede a bare URL without gluing it to a word. */
const URL_PREFIX_OK = /[\s(<[{*_~"']/;

/** Hard ceiling on delimiter-matching work so a pathological line cannot hang a build. */
const MAX_DELIMITER_STEPS = 200000;

/**
 * Normalise a link reference label the way CommonMark does: trim, collapse internal
 * whitespace, case-fold.
 * @param {string} label
 * @returns {string}
 */
export function normalizeLabel(label) {
  return String(label).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Flatten inline nodes to plain text (used for image `alt` and heading slugs).
 * @param {import('./parser.js').Inline[]} nodes
 * @returns {string}
 */
export function inlineToText(nodes) {
  let out = '';
  for (const node of nodes || []) {
    if (node.type === 'text' || node.type === 'inlineCode') out += node.value;
    else if (node.type === 'break') out += ' ';
    else if (node.type === 'image') out += node.alt;
    else if (node.children) out += inlineToText(node.children);
  }
  return out;
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isWhitespaceChar(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isPunctChar(ch) {
  return ch !== undefined && UNICODE_PUNCT.test(ch);
}

/**
 * Find the `]` that closes a bracket run starting at `open`, tolerating nested pairs
 * and backslash escapes. Returns -1 when unbalanced.
 * @param {string} text
 * @param {number} open index of the `[`
 * @returns {number}
 */
function findLabelEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse an inline link tail `(url "title")` beginning at the `(`.
 * @param {string} text
 * @param {number} start index of `(`
 * @returns {{ url: string, title: string|null, end: number }|null}
 */
function parseInlineDestination(text, start) {
  let i = start + 1;
  while (i < text.length && isWhitespaceChar(text[i])) i += 1;

  let url = '';
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1);
    if (close === -1) return null;
    url = text.slice(i + 1, close).replace(/\\(.)/g, '$1');
    i = close + 1;
  } else {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && text[i + 1] !== undefined) { url += text[i + 1]; i += 2; continue; }
      if (isWhitespaceChar(ch)) break;
      if (ch === '(') { depth += 1; url += ch; i += 1; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth -= 1;
        url += ch;
        i += 1;
        continue;
      }
      url += ch;
      i += 1;
    }
  }

  while (i < text.length && isWhitespaceChar(text[i])) i += 1;

  let title = null;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    let j = i + 1;
    let value = '';
    let closed = false;
    while (j < text.length) {
      if (text[j] === '\\' && text[j + 1] !== undefined) { value += text[j + 1]; j += 2; continue; }
      if (text[j] === closer) { closed = true; break; }
      value += text[j];
      j += 1;
    }
    if (!closed) return null;
    title = value;
    i = j + 1;
    while (i < text.length && isWhitespaceChar(text[i])) i += 1;
  }

  if (text[i] !== ')') return null;
  return { url, title, end: i + 1 };
}

/**
 * Trim punctuation a sentence lent to a bare URL: `see https://x.dev/a.` keeps `/a`.
 * @param {string} url
 * @returns {string}
 */
function trimUrlTail(url) {
  // Paren counts are maintained incrementally. Recounting inside the loop turned a line
  // of N trailing `)` into O(N^2) work -- 40k of them took 24s, which is a build-hanging
  // denial of service from one line of Markdown. `(` is never trimmed, so `opens` is
  // constant and only `closes` has to move.
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < url.length; i += 1) {
    if (url[i] === '(') opens += 1;
    else if (url[i] === ')') closes += 1;
  }

  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (last === ')') {
      // A closing paren is part of the URL as long as the URL opened one.
      if (closes <= opens) break;
      closes -= 1;
    } else if (!'.,;:!?\'">*_~'.includes(last)) {
      break;
    }
    end -= 1;
  }
  return end === url.length ? url : url.slice(0, end);
}

/**
 * Scan one block's text into inline nodes.
 *
 * @param {string} text the block's raw text; `\n` separates its source lines
 * @param {Object} [options]
 * @param {number} [options.line] 1-based source line of `text[0]`
 * @param {number} [options.column] 1-based source column of `text[0]`
 * @param {number[]} [options.columns] per-line source start columns; when supplied this
 *   wins over `column` and keeps positions exact inside indented containers
 * @param {{ add: Function }|null} [options.bag] diagnostic collector
 * @param {Map<string, { url: string, title: string|null }>} [options.definitions]
 *   link reference definitions collected in the parser's first pass
 * @returns {import('./parser.js').Inline[]}
 */
export function parseInline(text, options = {}) {
  const {
    line = 1,
    column = 1,
    columns = null,
    bag = null,
    definitions = new Map(),
  } = options;

  const src = String(text);

  // A link tail can only close on a `)`. Knowing the last one up front turns the
  // "scan forward hoping for a closer" case from O(n) per opener into O(1), which is the
  // difference between milliseconds and minutes on a line of 20000 unclosed `[x](`.
  const lastCloseParen = src.lastIndexOf(')');

  // ---- position mapping ---------------------------------------------------------
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }

  /**
   * @param {number} offset
   * @returns {{ line: number, column: number }}
   */
  const posAt = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const base = columns ? (columns[lo] ?? 1) : (lo === 0 ? column : 1);
    return { line: line + lo, column: base + (offset - lineStarts[lo]) };
  };

  /**
   * @param {string} code
   * @param {number} offset
   * @param {number} length
   * @param {string} message
   * @param {string|null} [hint]
   */
  const report = (code, offset, length, message, hint = null) => {
    const at = posAt(offset);
    bag?.add(code, {
      line: at.line,
      column: at.column,
      endLine: at.line,
      endColumn: at.column + Math.max(1, length),
    }, message, hint);
  };

  // ---- output list (doubly linked so emphasis can wrap arbitrary ranges) ---------
  const head = { node: null, prev: null, next: null };
  let tail = head;

  /** @param {object} node @returns {{node: object, prev: object, next: object|null}} */
  const push = (node) => {
    const entry = { node, prev: tail, next: null };
    tail.next = entry;
    tail = entry;
    return entry;
  };
  /** @param {{prev: object, next: object|null}} entry */
  const unlink = (entry) => {
    entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    else tail = entry.prev;
  };
  /** @param {object} entry @param {object} node */
  const insertBefore = (entry, node) => {
    const fresh = { node, prev: entry.prev, next: entry };
    entry.prev.next = fresh;
    entry.prev = fresh;
    return fresh;
  };

  let pending = '';
  let pendingStart = 0;
  const flush = () => {
    if (pending === '') return;
    const at = posAt(pendingStart);
    push({ type: 'text', line: at.line, column: at.column, value: pending });
    pending = '';
  };
  /** @param {string} chunk @param {number} offset */
  const addText = (chunk, offset) => {
    if (pending === '') pendingStart = offset;
    pending += chunk;
  };

  /** @type {Array<{ e: object, char: string, offset: number, length: number, origLength: number, canOpen: boolean, canClose: boolean, removed: boolean }>} */
  const delims = [];
  /** @type {Array<{ e: object, offset: number, image: boolean, active: boolean, delimBottom: number }>} */
  const brackets = [];

  // ---- emphasis resolution ------------------------------------------------------
  /**
   * CommonMark's `process_emphasis`, restricted to the delimiters above `bottom`.
   * @param {number} bottom
   */
  const processEmphasis = (bottom) => {
    /** @type {Map<string, number>} */
    const openersBottom = new Map();
    let ci = bottom;
    let steps = 0;

    while (ci < delims.length) {
      if ((steps += 1) > MAX_DELIMITER_STEPS) break;
      const closer = delims[ci];
      if (closer.removed || !closer.canClose) { ci += 1; continue; }

      const key = `${closer.char}|${closer.origLength % 3}|${closer.canOpen ? 1 : 0}`;
      const floor = Math.max(bottom - 1, openersBottom.get(key) ?? bottom - 1);

      let opener = null;
      let openerIndex = -1;
      for (let oi = ci - 1; oi > floor; oi -= 1) {
        const candidate = delims[oi];
        if (candidate.removed || !candidate.canOpen || candidate.char !== closer.char) continue;
        // "Rule of three": a run that both opens and closes may only pair up when the
        // combined lengths are not a multiple of 3. Keeps `*a**b*` sane.
        const oddMatch = (closer.canOpen || candidate.canClose)
          && (closer.origLength + candidate.origLength) % 3 === 0
          && !(closer.origLength % 3 === 0 && candidate.origLength % 3 === 0);
        if (oddMatch) continue;
        opener = candidate;
        openerIndex = oi;
        break;
      }

      if (!opener) {
        openersBottom.set(key, ci - 1);
        if (!closer.canOpen) closer.removed = true;
        ci += 1;
        continue;
      }

      const use = closer.char === '~'
        ? 2
        : (opener.length >= 2 && closer.length >= 2 ? 2 : 1);

      /** @type {object[]} */
      const children = [];
      for (let e = opener.e.next; e && e !== closer.e;) {
        const next = e.next;
        children.push(e.node);
        unlink(e);
        e = next;
      }

      const type = closer.char === '~' ? 'delete' : (use === 2 ? 'strong' : 'emphasis');
      // Delimiters are consumed from the *inside* of each run, so the construct starts
      // at the tail of whatever is left of the opener.
      const at = posAt(opener.offset + opener.length - use);
      insertBefore(closer.e, { type, line: at.line, column: at.column, children });

      opener.length -= use;
      closer.length -= use;
      opener.e.node.value = opener.char.repeat(opener.length);
      closer.e.node.value = closer.char.repeat(closer.length);
      closer.offset += use;

      for (let k = openerIndex + 1; k < ci; k += 1) delims[k].removed = true;
      if (opener.length === 0) { unlink(opener.e); opener.removed = true; }
      if (closer.length === 0) { unlink(closer.e); closer.removed = true; ci += 1; }
    }
  };

  // ---- main scan ----------------------------------------------------------------
  let i = 0;
  while (i < src.length) {
    const start = i;
    const ch = src[i];

    // Backslash escape / backslash hard break.
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        flush();
        const at = posAt(i);
        push({ type: 'break', line: at.line, column: at.column });
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        continue;
      }
      if (next !== undefined && PUNCTUATION.test(next)) { addText(next, i); i += 2; continue; }
      addText('\\', i);
      i += 1;
      continue;
    }

    // Code span: a run of n backticks closed by another run of exactly n.
    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n += 1;
      const contentStart = i + n;
      let scan = contentStart;
      let close = -1;
      while (scan < src.length) {
        if (src[scan] !== '`') { scan += 1; continue; }
        let m = 0;
        while (src[scan + m] === '`') m += 1;
        if (m === n) { close = scan; break; }
        scan += m;
      }
      if (close === -1) {
        report('MD021', i, n, `unmatched run of ${n} backtick${n > 1 ? 's' : ''}`,
          'Close the code span with the same number of backticks, or escape it as \\`.');
        addText('`'.repeat(n), i);
        i = contentStart;
        continue;
      }
      let value = src.slice(contentStart, close).replace(/\n/g, ' ');
      if (value.length > 2 && value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) {
        value = value.slice(1, -1);
      }
      flush();
      const at = posAt(i);
      push({ type: 'inlineCode', line: at.line, column: at.column, value });
      i = close + n;
      continue;
    }

    // Autolinks and raw inline HTML.
    if (ch === '<') {
      const rest = src.slice(i);
      const uri = AUTOLINK_URI.exec(rest);
      if (uri) {
        flush();
        const at = posAt(i);
        push({
          type: 'link',
          line: at.line,
          column: at.column,
          url: uri[1],
          title: null,
          reference: null,
          children: [{ type: 'text', line: at.line, column: at.column + 1, value: uri[1] }],
        });
        i += uri[0].length;
        continue;
      }
      const email = AUTOLINK_EMAIL.exec(rest);
      if (email) {
        flush();
        const at = posAt(i);
        push({
          type: 'link',
          line: at.line,
          column: at.column,
          url: `mailto:${email[1]}`,
          title: null,
          reference: null,
          children: [{ type: 'text', line: at.line, column: at.column + 1, value: email[1] }],
        });
        i += email[0].length;
        continue;
      }
      const raw = HTML_COMMENT.exec(rest) || HTML_CDATA.exec(rest) || HTML_PI.exec(rest)
        || HTML_DECL.exec(rest) || HTML_TAG.exec(rest);
      if (raw) {
        // Sanitisation is the renderer's job -- it owns the allow/escape/report policy.
        flush();
        const at = posAt(i);
        push({ type: 'html', line: at.line, column: at.column, value: raw[0] });
        i += raw[0].length;
        continue;
      }
      addText('<', i);
      i += 1;
      continue;
    }

    // Footnote reference / image opener / link opener.
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const image = ch === '!';
      const bracketAt = image ? i + 1 : i;

      if (!image && src[i + 1] === '^') {
        const close = findLabelEnd(src, i);
        const label = close === -1 ? null : src.slice(i + 2, close);
        if (label !== null && label !== '' && !/[\s\]]/.test(label) && src[close + 1] !== ':') {
          flush();
          const at = posAt(i);
          push({ type: 'footnoteReference', line: at.line, column: at.column, identifier: label });
          i = close + 1;
          continue;
        }
      }

      flush();
      const marker = image ? '![' : '[';
      const at = posAt(i);
      const entry = push({ type: 'text', line: at.line, column: at.column, value: marker });
      brackets.push({ e: entry, offset: bracketAt, image, active: true, delimBottom: delims.length });
      i += marker.length;
      continue;
    }

    if (ch === ']') {
      const opener = brackets.pop();
      if (!opener || !opener.active) { addText(']', i); i += 1; continue; }

      const labelText = src.slice(opener.offset + 1, i);
      let url = null;
      let title = null;
      let reference = null;
      let consumedTo = -1;

      if (src[i + 1] === '(') {
        const dest = i + 1 < lastCloseParen ? parseInlineDestination(src, i + 1) : null;
        if (dest) {
          url = dest.url;
          title = dest.title;
          consumedTo = dest.end;
          if (url === '') {
            report('MD042', opener.offset, i - opener.offset + 1, 'link destination is empty',
              'Give the link a target, or drop the brackets if it is not a link.');
          }
        } else {
          report('MD040', i + 1, 1, 'link destination is never closed',
            'Add the missing `)` -- or escape the bracket as \\( if it is literal text.');
        }
      }

      if (consumedTo === -1) {
        let label = null;
        let explicit = false;
        if (src[i + 1] === '[') {
          const close = findLabelEnd(src, i + 1);
          if (close !== -1) {
            const inner = src.slice(i + 2, close);
            label = inner.trim() === '' ? labelText : inner;
            explicit = true;
            consumedTo = close + 1;
          }
        }
        if (label === null) { label = labelText; consumedTo = i + 1; }

        const key = normalizeLabel(label);
        const def = key ? definitions.get(key) : undefined;
        if (def) {
          url = def.url;
          title = def.title;
          reference = key;
        } else if (explicit) {
          // Full `[a][b]` and collapsed `[a][]` forms are unambiguous intent, so a miss
          // is a real error. A bare `[a]` is left alone: flagging every bracketed word
          // in prose would bury the findings that matter.
          report('MD041', opener.offset, consumedTo - opener.offset,
            `link reference \`${key}\` has no matching definition`,
            `Add a definition line such as \`[${key}]: https://example.com\`.`);
          consumedTo = -1;
        } else {
          consumedTo = -1;
        }
      }

      if (consumedTo === -1) {
        // Not a link after all: the opener stays as literal `[` / `![` text.
        addText(']', i);
        i += 1;
        continue;
      }

      processEmphasis(opener.delimBottom);
      flush();

      /** @type {object[]} */
      const children = [];
      for (let e = opener.e.next; e;) {
        const next = e.next;
        children.push(e.node);
        unlink(e);
        e = next;
      }
      unlink(opener.e);
      delims.length = opener.delimBottom;

      const at = posAt(opener.offset - (opener.image ? 1 : 0));
      if (opener.image) {
        push({
          type: 'image',
          line: at.line,
          column: at.column,
          url: url ?? '',
          title: title ?? null,
          alt: inlineToText(children),
        });
      } else {
        push({
          type: 'link',
          line: at.line,
          column: at.column,
          url: url ?? '',
          title: title ?? null,
          reference,
          children,
        });
        // A link may not contain a link: neutralise every enclosing text opener.
        for (const bracket of brackets) if (!bracket.image) bracket.active = false;
      }

      i = consumedTo;
      continue;
    }

    // Emphasis / strikethrough delimiter runs.
    if (ch === '*' || ch === '_' || ch === '~') {
      let n = 0;
      while (src[i + n] === ch) n += 1;

      // Only `~~` is strikethrough. A single `~` is a home directory, not markup.
      if (ch === '~' && n !== 2) { addText(ch.repeat(n), i); i += n; continue; }

      const before = i > 0 ? src[i - 1] : undefined;
      const after = src[i + n];
      const beforeWs = isWhitespaceChar(before);
      const afterWs = isWhitespaceChar(after);
      const beforePunct = isPunctChar(before);
      const afterPunct = isPunctChar(after);

      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);

      let canOpen;
      let canClose;
      if (ch === '_') {
        // Intraword `_` must not emphasise: `snake_case_name` stays literal.
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }

      flush();
      const at = posAt(i);
      const entry = push({ type: 'text', line: at.line, column: at.column, value: ch.repeat(n) });
      delims.push({
        e: entry, char: ch, offset: i, length: n, origLength: n, canOpen, canClose, removed: false,
      });
      i += n;
      continue;
    }

    // Line ending: two or more trailing spaces make a hard break.
    if (ch === '\n') {
      const trailing = /[ \t]*$/.exec(pending)[0];
      if (trailing.length > 0) pending = pending.slice(0, pending.length - trailing.length);
      if (/^ {2,}$/.test(trailing)) {
        flush();
        const at = posAt(i);
        push({ type: 'break', line: at.line, column: at.column });
      } else {
        addText('\n', i);
      }
      i += 1;
      while (src[i] === ' ' || src[i] === '\t') i += 1;
      continue;
    }

    // Bare URL linkification. Skipped inside any open bracket so we never nest anchors
    // and never rewrite the inside of a link label.
    if ((ch === 'h' || ch === 'w') && (i === 0 || URL_PREFIX_OK.test(src[i - 1]))
        && brackets.length === 0) {
      const match = BARE_URL.exec(src.slice(i));
      if (match) {
        const raw = trimUrlTail(match[0]);
        const host = raw.replace(/^https?:\/\//, '');
        if (host.length > 3 && host.includes('.')) {
          flush();
          const at = posAt(i);
          push({
            type: 'link',
            line: at.line,
            column: at.column,
            url: raw.startsWith('www.') ? `https://${raw}` : raw,
            title: null,
            reference: null,
            children: [{ type: 'text', line: at.line, column: at.column, value: raw }],
          });
          report('MD047', i, raw.length, 'bare URL was linkified automatically',
            `Write it as <${raw}> or [text](${raw}) to make the intent explicit.`);
          i += raw.length;
          continue;
        }
      }
    }

    addText(ch, i);
    i += 1;

    /* c8 ignore next */
    if (i <= start) i = start + 1; // belt and braces: the cursor always moves
  }

  flush();
  processEmphasis(0);

  // Unclosed `![` never becomes an image -- worth an error, unlike a stray `[`.
  for (const bracket of brackets) {
    if (bracket.image) {
      report('MD040', bracket.offset - 1, 2, 'image is never closed',
        'Add the matching `]`, or escape the bracket as \\!\\[.');
    }
  }

  for (const delim of delims) {
    if (delim.removed || delim.length === 0 || !delim.canOpen) continue;
    // `2*3` is arithmetic, not a failed emphasis.
    if (delim.char === '*' && /\d/.test(src[delim.offset - 1] ?? '') && /\d/.test(src[delim.offset + delim.origLength] ?? '')) {
      continue;
    }
    const run = delim.char.repeat(delim.length);
    report('MD050', delim.offset, delim.length, `unclosed \`${run}\` emphasis marker`,
      `Add a matching \`${run}\`, or escape it as \\${delim.char}.`);
  }

  /** @type {object[]} */
  const out = [];
  for (let e = head.next; e; e = e.next) {
    if (e.node.type === 'text' && e.node.value === '') continue;
    out.push(e.node);
  }
  return out;
}
