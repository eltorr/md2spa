/**
 * Frontmatter parsing -- a small, hand-written YAML subset.
 *
 * A real YAML parser is a dependency we refuse to take, and 99% of documentation
 * frontmatter is scalars, one level of nesting and a couple of lists. So this module
 * implements exactly that and reports anything it cannot understand as `MD001` at the
 * offending line/column instead of guessing.
 *
 * Deliberate policy: **arbitrary keys are preserved untouched**. Real corpora carry
 * device metadata (`iso_layout`, `fnmode`, `summary`) that no schema anticipates.
 * Type checking of the *known* keys lives in `validate.js` (MD002), never here.
 *
 * Supported: `key: value` scalars (string / number / boolean / null, single- and
 * double-quoted), inline flow collections `[a, b]` and `{a: b}`, block sequences of
 * `- item`, nested mappings by indentation, `#` comments, and `|` / `>` block scalars
 * with `+`/`-` chomping.
 *
 * @module markdown/frontmatter
 */

/** Opening delimiter -- must be the very first line of the file. */
const OPEN_RE = /^---[ \t]*$/;

/** Closing delimiter. YAML's `...` end-of-document marker is accepted too. */
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/** A line that carries no data. */
const SKIP_RE = /^[ \t]*(?:#.*)?$/;

/** Block scalar header, e.g. `|`, `|-`, `>2`, `|+`. */
const BLOCK_SCALAR_RE = /^([|>])([0-9+-]{0,2})[ \t]*$/;

/**
 * Plain scalars that look like numbers. Leading zeros are excluded so `0755` and `01`
 * survive as strings -- version and id fields are far more common than octal.
 */
const NUMBER_RE = /^[-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/;

/** Recursion ceiling. Frontmatter this deep is a bug, not a document. */
const MAX_DEPTH = 8;

/**
 * Measure a line's leading whitespace, expanding tabs to the next multiple of 4.
 * @param {string} line
 * @returns {{ chars: number, width: number }}
 */
function measureIndent(line) {
  let chars = 0;
  let width = 0;
  while (chars < line.length) {
    const ch = line[chars];
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
    chars += 1;
  }
  return { chars, width };
}

/**
 * Drop a trailing `# comment`.
 *
 * A quote only opens a string when it sits at the start of the value or right after a
 * flow separator -- otherwise `Don't panic # note` would swallow its own comment.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (i === 0 || '[{,: '.includes(text[i - 1]))) {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Split `key: value`, honouring YAML's rule that the separator is a colon followed by
 * whitespace or end of line (so `time: 12:30` and `url: https://x` both work).
 *
 * @param {string} content line with indentation already removed
 * @returns {{ key: string, rest: string }|null}
 */
function splitKeyValue(content) {
  let quote = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && i === 0) {
      quote = ch;
      continue;
    }
    if (ch === ':') {
      const next = content[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        const rawKey = content.slice(0, i).trim();
        if (rawKey === '') return null;
        return { key: unquote(rawKey), rest: content.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function unquote(text) {
  if (text.length >= 2 && text[0] === '"' && text.endsWith('"')) return unescapeDouble(text.slice(1, -1));
  if (text.length >= 2 && text[0] === "'" && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/**
 * @param {string} text
 * @returns {string}
 */
function unescapeDouble(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      default: return esc;
    }
  });
}

/**
 * Split a flow collection body on top-level commas.
 * @param {string} body text between the brackets
 * @returns {string[]}
 */
function splitFlow(body) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '' || out.length > 0) out.push(current);
  return out;
}

/**
 * Interpret a single scalar / flow value.
 * @param {string} raw
 * @param {number} depth
 * @returns {unknown}
 */
function parseValue(raw, depth) {
  const text = stripComment(raw).trim();
  if (text === '' || text === '~') return null;
  if (text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;

  if (text.length >= 2 && text[0] === '"' && text.endsWith('"')) return unescapeDouble(text.slice(1, -1));
  if (text.length >= 2 && text[0] === "'" && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");

  if (depth < MAX_DEPTH && text[0] === '[' && text.endsWith(']')) {
    const body = text.slice(1, -1).trim();
    if (body === '') return [];
    return splitFlow(body).map((item) => parseValue(item, depth + 1));
  }

  if (depth < MAX_DEPTH && text[0] === '{' && text.endsWith('}')) {
    /** @type {Record<string, unknown>} */
    const map = {};
    const body = text.slice(1, -1).trim();
    if (body === '') return map;
    for (const entry of splitFlow(body)) {
      const pair = splitKeyValue(entry.trim());
      if (pair) map[pair.key] = parseValue(pair.rest, depth + 1);
    }
    return map;
  }

  if (NUMBER_RE.test(text) && !/^[-+]?0\d/.test(text)) return Number(text);
  return text;
}

/**
 * Fold a folded (`>`) block scalar: blank lines become newlines, everything else joins
 * with a single space.
 * @param {string[]} lines
 * @returns {string}
 */
function foldLines(lines) {
  /** @type {string[]} */
  const paragraphs = [];
  /** @type {string[]} */
  let current = [];
  for (const line of lines) {
    if (line === '') { paragraphs.push(current.join(' ')); current = []; continue; }
    current.push(line);
  }
  paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

/**
 * Remove up to `width` columns of leading whitespace, expanding tabs.
 * @param {string} line
 * @param {number} width
 * @returns {string}
 */
function dedent(line, width) {
  let chars = 0;
  let w = 0;
  while (chars < line.length && w < width) {
    const ch = line[chars];
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
    chars += 1;
  }
  return (w > width ? ' '.repeat(w - width) : '') + line.slice(chars);
}

/**
 * @typedef {Object} YamlCtx
 * @property {string[]} lines
 * @property {number} i cursor into `lines`
 * @property {number} firstLine 1-based source line number of `lines[0]`
 * @property {{ add: Function }|null} bag
 */

/**
 * @param {YamlCtx} ctx
 * @param {number} idx
 * @returns {number}
 */
function lineNo(ctx, idx) {
  return ctx.firstLine + idx;
}

/**
 * @param {YamlCtx} ctx
 * @param {number} idx
 * @param {string} message
 * @param {string|null} [hint]
 */
function bad(ctx, idx, message, hint = null) {
  const line = lineNo(ctx, idx);
  const column = measureIndent(ctx.lines[idx]).chars + 1;
  ctx.bag?.add('MD001', {
    line,
    column,
    endLine: line,
    endColumn: Math.max(column + 1, ctx.lines[idx].length + 1),
  }, message, hint);
}

/**
 * Index of the next line carrying data, or -1.
 * @param {YamlCtx} ctx
 * @returns {number}
 */
function nextMeaningful(ctx) {
  for (let k = ctx.i; k < ctx.lines.length; k += 1) {
    if (!SKIP_RE.test(ctx.lines[k])) return k;
  }
  return -1;
}

/**
 * Consume a `|` / `>` block scalar owned by a key at `baseIndent`.
 * @param {YamlCtx} ctx
 * @param {number} baseIndent
 * @param {string} style `|` or `>`
 * @param {string} modifiers chomping indicator and/or explicit indent digit
 * @returns {string}
 */
function parseBlockScalar(ctx, baseIndent, style, modifiers) {
  const chomp = /[+-]/.exec(modifiers)?.[0] ?? '';
  const explicit = /\d/.exec(modifiers)?.[0];

  /** @type {string[]} */
  const raw = [];
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.trim() === '') { raw.push(''); ctx.i += 1; continue; }
    if (measureIndent(line).width <= baseIndent) break;
    raw.push(line);
    ctx.i += 1;
  }

  // Trailing blank lines belong to the next construct unless chomping keeps them.
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '') end -= 1;
  const keptBlanks = raw.length - end;
  ctx.i -= keptBlanks;
  const body = raw.slice(0, end);
  if (body.length === 0) return '';

  const contentWidth = explicit
    ? baseIndent + Number(explicit)
    : measureIndent(body.find((l) => l.trim() !== '') ?? body[0]).width;
  const stripped = body.map((l) => (l.trim() === '' ? '' : dedent(l, contentWidth)));

  const text = style === '|' ? stripped.join('\n') : foldLines(stripped);
  if (chomp === '-') return text;
  if (chomp === '+') return `${text}\n${'\n'.repeat(keptBlanks)}`;
  return `${text}\n`;
}

/**
 * Parse a block sequence whose `-` markers sit at `seqIndent`.
 * @param {YamlCtx} ctx
 * @param {number} seqIndent
 * @param {number} depth
 * @returns {unknown[]}
 */
function parseSequence(ctx, seqIndent, depth) {
  /** @type {unknown[]} */
  const out = [];
  while (ctx.i < ctx.lines.length) {
    const idx = ctx.i;
    const line = ctx.lines[idx];
    if (SKIP_RE.test(line)) { ctx.i += 1; continue; }

    const { chars, width } = measureIndent(line);
    if (width < seqIndent) break;
    const content = line.slice(chars);
    if (!(content === '-' || content.startsWith('- ') || content.startsWith('-\t'))) break;
    if (width > seqIndent) {
      bad(ctx, idx, 'list item is indented deeper than its list', 'Align every `-` in a list to the same column.');
      ctx.i += 1;
      continue;
    }

    const item = content.slice(1).trim();
    if (item === '') {
      ctx.i += 1;
      const next = nextMeaningful(ctx);
      if (next !== -1 && depth < MAX_DEPTH) {
        const nested = measureIndent(ctx.lines[next]);
        const nestedContent = ctx.lines[next].slice(nested.chars);
        if (nested.width > seqIndent) {
          ctx.i = next;
          out.push(nestedContent.startsWith('- ') || nestedContent === '-'
            ? parseSequence(ctx, nested.width, depth + 1)
            : parseMapping(ctx, nested.width, depth + 1));
          continue;
        }
      }
      out.push(null);
      continue;
    }

    // `- key: value` is a one-entry mapping in YAML, and real corpora use it. Rewriting
    // the marker to a space lets the mapping parser own the item and its continuation
    // lines without a second code path. `ctx.lines` is a private copy, so this is safe.
    if (depth < MAX_DEPTH && splitKeyValue(item)) {
      ctx.lines[idx] = `${line.slice(0, chars)} ${line.slice(chars + 1)}`;
      const keyIndent = measureIndent(ctx.lines[idx]).width;
      out.push(parseMapping(ctx, keyIndent, depth + 1));
      continue;
    }

    out.push(parseValue(item, depth + 1));
    ctx.i += 1;
  }
  return out;
}

/**
 * Parse a mapping whose keys sit at `baseIndent`.
 * @param {YamlCtx} ctx
 * @param {number} baseIndent
 * @param {number} depth
 * @returns {Record<string, unknown>}
 */
function parseMapping(ctx, baseIndent, depth) {
  /** @type {Record<string, unknown>} */
  const map = {};
  while (ctx.i < ctx.lines.length) {
    const idx = ctx.i;
    const line = ctx.lines[idx];
    if (SKIP_RE.test(line)) { ctx.i += 1; continue; }

    const { chars, width } = measureIndent(line);
    if (width < baseIndent) break;
    const content = line.slice(chars);

    if (width > baseIndent) {
      bad(ctx, idx, 'unexpected indentation', 'Align this key with the keys around it.');
      ctx.i += 1;
      continue;
    }

    if (content === '-' || content.startsWith('- ')) {
      bad(ctx, idx, 'expected `key: value`, found a list item',
        'A list needs a key above it, e.g. `tags:` followed by the `-` lines.');
      ctx.i += 1;
      continue;
    }

    const pair = splitKeyValue(content);
    if (!pair) {
      bad(ctx, idx, 'expected `key: value`',
        'Frontmatter entries look like `title: My page`. A colon must be followed by a space.');
      ctx.i += 1;
      continue;
    }

    ctx.i += 1;
    const { key, rest } = pair;
    const block = BLOCK_SCALAR_RE.exec(rest);

    if (block) {
      map[key] = parseBlockScalar(ctx, baseIndent, block[1], block[2]);
      continue;
    }

    if (rest !== '') {
      map[key] = parseValue(rest, depth + 1);
      continue;
    }

    // Empty value: the real value may be an indented block below.
    const next = nextMeaningful(ctx);
    if (next === -1 || depth >= MAX_DEPTH) { map[key] = null; continue; }
    const nested = measureIndent(ctx.lines[next]);
    const nestedContent = ctx.lines[next].slice(nested.chars);
    const isSeqItem = nestedContent === '-' || nestedContent.startsWith('- ');

    if (isSeqItem && nested.width >= baseIndent) {
      ctx.i = next;
      map[key] = parseSequence(ctx, nested.width, depth + 1);
    } else if (nested.width > baseIndent) {
      ctx.i = next;
      map[key] = parseMapping(ctx, nested.width, depth + 1);
    } else {
      map[key] = null;
    }
  }
  return map;
}

/**
 * Extract and parse a `---` delimited frontmatter block.
 *
 * When there is no frontmatter the source is returned untouched with `bodyStartLine: 1`,
 * so callers can always pass `bodyStartLine` straight to the lexer.
 *
 * @param {string} source full document text, CRLF and BOM already normalised
 * @param {{ add: Function }|null} [bag] diagnostic collector; MD001 is reported here
 * @returns {{ data: Record<string, unknown>, body: string, bodyStartLine: number, raw: string }}
 */
export function parseFrontmatter(source, bag = null) {
  const text = String(source);
  const lines = text.split('\n');

  if (lines.length === 0 || !OPEN_RE.test(lines[0])) {
    return { data: {}, body: text, bodyStartLine: 1, raw: '' };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (CLOSE_RE.test(lines[i])) { close = i; break; }
  }

  if (close === -1) {
    bag?.add('MD001', { line: 1, column: 1, endLine: 1, endColumn: 4 },
      'frontmatter block is never closed',
      'Add a line containing only `---` after the metadata.');
    return { data: {}, body: text, bodyStartLine: 1, raw: '' };
  }

  const rawLines = lines.slice(1, close);
  /** @type {YamlCtx} */
  const ctx = { lines: rawLines.slice(), i: 0, firstLine: 2, bag };
  const data = parseMapping(ctx, 0, 0);

  return {
    data,
    body: lines.slice(close + 1).join('\n'),
    bodyStartLine: close + 2,
    raw: rawLines.join('\n'),
  };
}
