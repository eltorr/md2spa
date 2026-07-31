/**
 * The block-level scanner.
 *
 * Turns Markdown source into the `Block[]` described in SPEC section 4. Container
 * blocks -- blockquotes, list items, admonitions, footnote definitions -- strip their
 * own prefix and recurse through `tokenizeBlocks`, which keeps line numbers exact
 * (one output line per input line) and threads the *source column* of every line
 * through `lineColumns` so nested inline diagnostics still point at the right character.
 *
 * Leaf blocks call `parseInline` directly. Link reference definitions are emitted as
 * `definition` nodes rather than being swallowed, so the parser can collect them and the
 * validator can notice the ones nobody uses.
 *
 * @module markdown/lexer
 */

import { parseInline, inlineToText, normalizeLabel } from './inline.js';
import { slugify } from './slug.js';

const ATX_RE = /^( {0,3})(#{1,6})(?!#)(.*)$/;

/** Deepest blockquote/list/admonition nesting the lexer will recurse into. */
const MAX_CONTAINER_DEPTH = 64;
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const THEMATIC_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const LIST_MARKER_RE = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))([ \t]+|$)/;
const MKDOCS_RE = /^( {0,3})(!!!|\?\?\?\+?)[ \t]+([A-Za-z][\w-]*)(?:[ \t]+(.*))?$/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;
const FOOTNOTE_DEF_RE = /^( {0,3})\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const LINK_DEF_RE = /^( {0,3})\[((?:[^\][\\]|\\.)+)\]:[ \t]*(.*)$/;
const HTML_COMMENT_OPEN = /^ {0,3}<!--/;
const HTML_RAW_OPEN = /^ {0,3}<(script|pre|style|textarea)\b/i;
const HTML_TAG_OPEN = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)[\s/>]/;

/**
 * Tags that begin an HTML block (CommonMark type 6). Anything else -- `<your-volume>`,
 * `<key>`, `<VDM>` -- stays prose, which is the only way technical docs survive.
 */
const BLOCK_HTML_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li',
  'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option',
  'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

/** GitHub alert keyword -> admonition kind. */
const ALERT_KINDS = {
  note: 'note', tip: 'tip', important: 'important', warning: 'warning', caution: 'danger',
};

/**
 * Leading whitespace of a line, with tabs expanded to the next multiple of 4.
 * @param {string} line
 * @returns {{ chars: number, width: number, hasTab: boolean }}
 */
function measureIndent(line) {
  let chars = 0;
  let width = 0;
  let hasTab = false;
  while (chars < line.length) {
    const ch = line[chars];
    if (ch === ' ') width += 1;
    else if (ch === '\t') { width += 4 - (width % 4); hasTab = true; }
    else break;
    chars += 1;
  }
  return { chars, width, hasTab };
}

/**
 * Cut the first `width` display columns off a line. Callers only use this where those
 * columns are known to be strippable -- leading whitespace, or a list marker whose width
 * `matchListMarker` measured. A partially consumed tab is refunded as spaces.
 * @param {string} line
 * @param {number} width
 * @returns {{ text: string, chars: number }} `chars` is how many source characters went
 */
function stripWidth(line, width) {
  let chars = 0;
  let w = 0;
  while (chars < line.length && w < width) {
    w += line[chars] === '\t' ? 4 - (w % 4) : 1;
    chars += 1;
  }
  const pad = w > width ? ' '.repeat(w - width) : '';
  return { text: pad + line.slice(chars), chars };
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isBlank(line) {
  return line.trim() === '';
}

/**
 * A GFM table delimiter row. Deliberately loose -- `|===|` is caught here and then
 * reported as MD032 rather than silently degrading the whole table to a paragraph.
 * @param {string} line
 * @returns {boolean}
 */
function isDelimiterRow(line) {
  const text = line.trim();
  if (!text.includes('|') || !/[-=]/.test(text)) return false;
  return /^[|\s:\-=_~.]+$/.test(text);
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function looksLikeTableRow(line) {
  const text = line.trim();
  return text.length > 1 && text.startsWith('|') && text.endsWith('|');
}

/**
 * Split a table row into cells, honouring `\|` escapes. Offsets are indices into `line`
 * so cell positions survive into diagnostics.
 * @param {string} line
 * @returns {Array<{ text: string, offset: number }>}
 */
function splitCells(line) {
  /** @type {Array<{ text: string, offset: number }>} */
  const cells = [];
  let current = '';
  let cellStart = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { current += '|'; i += 2; continue; }
    if (ch === '|') {
      cells.push({ text: current, offset: cellStart });
      current = '';
      i += 1;
      cellStart = i;
      continue;
    }
    current += ch;
    i += 1;
  }
  cells.push({ text: current, offset: cellStart });

  const trimmed = line.trim();
  if (cells.length > 1 && trimmed.startsWith('|') && isBlank(cells[0].text)) cells.shift();
  if (cells.length > 1 && trimmed.endsWith('|') && isBlank(cells[cells.length - 1].text)) cells.pop();

  return cells.map((cell) => {
    const lead = /^\s*/.exec(cell.text)[0].length;
    return { text: cell.text.trim(), offset: cell.offset + lead };
  });
}

/**
 * Decode a list marker at the start of a line.
 * @param {string} line
 * @returns {{ indent: number, marker: string, ordered: boolean, number: number|null,
 *             contentIndent: number, hasTab: boolean }|null}
 */
function matchListMarker(line) {
  const m = LIST_MARKER_RE.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const markerText = m[2] ?? `${m[3]}${m[4]}`;
  const spaces = m[5] ?? '';
  const afterMarker = indent + markerText.length;

  let spaceWidth = 0;
  for (const ch of spaces) spaceWidth += ch === '\t' ? 4 - ((afterMarker + spaceWidth) % 4) : 1;

  // No space, an empty item, or 5+ spaces (the surplus is indented code inside the item)
  // all put the content one column past the marker.
  const contentIndent = spaceWidth === 0 || spaceWidth > 4 || isBlank(line.slice(afterMarker))
    ? afterMarker + 1
    : afterMarker + spaceWidth;

  return {
    indent,
    marker: m[2] ?? m[4],
    ordered: m[3] !== undefined,
    number: m[3] !== undefined ? Number(m[3]) : null,
    contentIndent,
    hasTab: spaces.includes('\t'),
  };
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function startsHtmlBlock(line) {
  if (HTML_COMMENT_OPEN.test(line) || HTML_RAW_OPEN.test(line)) return true;
  const m = HTML_TAG_OPEN.exec(line);
  return !!m && BLOCK_HTML_TAGS.has(m[1].toLowerCase());
}

/* -------------------------------------------------------------------------- context */

/**
 * @typedef {Object} LexContext
 * @property {string[]} lines
 * @property {number} startLine 1-based source line of `lines[0]`
 * @property {{ add: Function }|null} bag
 * @property {object} config
 * @property {Map<string, { url: string, title: string|null }>} definitions
 * @property {number[]|null} cols per-line source start column
 * @property {boolean} inListItem true when these lines are a list item's stripped body
 */

/**
 * @param {LexContext} ctx
 * @param {number} idx
 * @returns {number}
 */
function lineNo(ctx, idx) {
  return ctx.startLine + idx;
}

/**
 * @param {LexContext} ctx
 * @param {number} idx
 * @param {number} [offset] 0-based offset within the line
 * @returns {number}
 */
function colAt(ctx, idx, offset = 0) {
  return (ctx.cols ? (ctx.cols[idx] ?? 1) : 1) + offset;
}

/**
 * @param {LexContext} ctx
 * @param {string} code
 * @param {number} idx
 * @param {number} offset
 * @param {number} length
 * @param {string} message
 * @param {string|null} [hint]
 */
function report(ctx, code, idx, offset, length, message, hint = null) {
  const line = lineNo(ctx, idx);
  const column = colAt(ctx, idx, offset);
  ctx.bag?.add(code, {
    line, column, endLine: line, endColumn: column + Math.max(1, length),
  }, message, hint);
}

/**
 * Recurse into a container's stripped body.
 * @param {LexContext} ctx
 * @param {number} firstIdx index in `ctx.lines` of `body[0]`
 * @param {string[]} body
 * @param {number[]} columns source start column of each body line
 * @param {boolean} [inListItem]
 * @returns {object[]}
 */
function descend(ctx, firstIdx, body, columns, inListItem = false) {
  // Container nesting is the one place the lexer recurses without bound, so a file of
  // 2000 `>` characters used to blow the JavaScript stack and take the whole build down
  // with it. Past the ceiling the markers are kept as literal text: the content still
  // reaches the page, and no legitimate document comes close to this depth.
  if (ctx.containerDepth >= MAX_CONTAINER_DEPTH) {
    const text = body.join('\n');
    if (!text.trim()) return [];
    return [{
      type: 'paragraph',
      line: lineNo(ctx, firstIdx),
      column: columns && columns[0] ? columns[0] : 1,
      children: [{
        type: 'text',
        value: text,
        line: lineNo(ctx, firstIdx),
        column: columns && columns[0] ? columns[0] : 1,
      }],
    }];
  }

  return tokenizeBlocks(body.join('\n'), {
    startLine: lineNo(ctx, firstIdx),
    bag: ctx.bag,
    config: ctx.config,
    definitions: ctx.definitions,
    lineColumns: columns,
    scanWhitespace: false,
    inListItem,
    containerDepth: ctx.containerDepth + 1,
  });
}

/**
 * Run the inline scanner over `text` spanning source lines `firstIdx..`.
 * @param {LexContext} ctx
 * @param {number} firstIdx
 * @param {string} text
 * @param {number[]} columns
 * @returns {object[]}
 */
function inline(ctx, firstIdx, text, columns) {
  return parseInline(text, {
    line: lineNo(ctx, firstIdx),
    column: columns[0] ?? 1,
    columns,
    bag: ctx.bag,
    definitions: ctx.definitions,
  });
}

/* --------------------------------------------------------------- whitespace prescan */

/**
 * MD063 / MD065 live here rather than in the block parsers: a raw line is visited once
 * at the top level, but many times over as containers recurse, and reporting it once is
 * the only sane option. Fenced code is exempt -- whitespace there is content.
 * @param {LexContext} ctx
 */
function reportWhitespace(ctx) {
  let fence = null;
  for (let i = 0; i < ctx.lines.length; i += 1) {
    const line = ctx.lines[i];

    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) { fence = open[2]; continue; }

    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes('\t')) {
      report(ctx, 'MD063', i, 0, lead.length, 'hard tab used for indentation',
        'Configure your editor to insert spaces; tab width is not portable.');
    }

    const trailing = /[ \t]+$/.exec(line);
    if (!trailing) continue;
    const isHardBreak = /^ {2,}$/.test(trailing[0])
      && !isBlank(line)
      && i + 1 < ctx.lines.length
      && !isBlank(ctx.lines[i + 1]);
    if (isHardBreak) continue;

    const offset = line.length - trailing[0].length;
    report(ctx, 'MD065', i, offset, trailing[0].length, 'trailing whitespace',
      isBlank(line)
        ? 'Blank lines should be empty.'
        : 'Remove it, or use exactly two spaces if you meant a hard line break.');
  }
}

/* ------------------------------------------------------------------- block builders */

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseFence(ctx, i) {
  const m = FENCE_OPEN_RE.exec(ctx.lines[i]);
  if (!m) return null;
  const [, indentStr, fence, info] = m;
  // A backtick fence's info string may not contain a backtick (it would be a code span).
  if (fence[0] === '`' && info.includes('`')) return null;

  let end = -1;
  for (let j = i + 1; j < ctx.lines.length; j += 1) {
    const close = FENCE_CLOSE_RE.exec(ctx.lines[j]);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { end = j; break; }
  }

  const bodyEnd = end === -1 ? ctx.lines.length : end;
  const value = ctx.lines.slice(i + 1, bodyEnd)
    .map((l) => stripWidth(l, indentStr.length).text)
    .join('\n');

  if (end === -1) {
    report(ctx, 'MD020', i, indentStr.length, fence.length,
      'fenced code block is never closed',
      `Add a closing \`${fence}\` line, or the rest of the document is swallowed as code.`);
  }

  let text = info.trim();
  let lang = null;
  let meta = null;
  if (text.startsWith('{')) {
    // Pandoc/MkDocs attribute syntax: ```{ .python title="x" }
    meta = text;
    lang = /\.([A-Za-z0-9_+-]+)/.exec(text)?.[1] ?? null;
  } else if (text !== '') {
    const space = text.search(/\s/);
    lang = space === -1 ? text : text.slice(0, space);
    meta = space === -1 ? null : text.slice(space + 1).trim() || null;
  }

  return {
    node: {
      type: 'code',
      line: lineNo(ctx, i),
      column: colAt(ctx, i, indentStr.length),
      lang,
      meta,
      value,
      fenced: true,
    },
    next: end === -1 ? ctx.lines.length : end + 1,
  };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseAtxHeading(ctx, i) {
  const m = ATX_RE.exec(ctx.lines[i]);
  if (!m) return null;
  const [, indentStr, hashes, rest] = m;
  const depth = hashes.length;
  const markerEnd = indentStr.length + depth;

  if (rest !== '' && !/^[ \t]/.test(rest)) {
    report(ctx, 'MD010', i, markerEnd, 1, `no space after \`${hashes}\``,
      `Write \`${hashes} ${rest.trim()}\` -- without the space this is a paragraph, not a heading.`);
  }

  const leading = /^[ \t]*/.exec(rest)[0].length;
  // A trailing run of `#` is a closing sequence, not content.
  const withoutClosing = rest.replace(/[ \t]+#+[ \t]*$/, '').replace(/^([ \t]*)#+[ \t]*$/, '$1');
  const text = withoutClosing.trim();
  const textOffset = markerEnd + leading;

  if (text === '') {
    report(ctx, 'MD015', i, indentStr.length, Math.max(1, ctx.lines[i].trim().length),
      'heading has no text',
      'Give the heading a title, or delete the line.');
  }

  const children = text === '' ? [] : inline(ctx, i, text, [colAt(ctx, i, textOffset)]);
  const plain = inlineToText(children);
  // `id` is provisional: the renderer owns the slug registry and re-assigns it with the
  // `-1`/`-2` de-duplication (and MD014) once it knows the whole document's headings.

  return {
    node: {
      type: 'heading',
      line: lineNo(ctx, i),
      column: colAt(ctx, i, indentStr.length),
      depth,
      children,
      id: slugify(plain),
      text: plain,
    },
    next: i + 1,
  };
}

/**
 * MkDocs-style admonitions: `!!! note "Title"`, `??? note` (collapsed) and `???+ note`
 * (collapsible, open). The body is everything indented four columns further.
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseMkdocsAdmonition(ctx, i) {
  const m = MKDOCS_RE.exec(ctx.lines[i]);
  if (!m) return null;
  const [, indentStr, marker, kind, tail] = m;
  const baseWidth = indentStr.length;
  const bodyWidth = baseWidth + 4;

  /** @type {string[]} */
  const body = [];
  /** @type {number[]} */
  const columns = [];
  let j = i + 1;
  while (j < ctx.lines.length) {
    if (isBlank(ctx.lines[j])) {
      let peek = j;
      while (peek < ctx.lines.length && isBlank(ctx.lines[peek])) peek += 1;
      if (peek >= ctx.lines.length || measureIndent(ctx.lines[peek]).width < bodyWidth) break;
      for (let k = j; k < peek; k += 1) { body.push(''); columns.push(colAt(ctx, k)); }
      j = peek;
      continue;
    }
    if (measureIndent(ctx.lines[j]).width < bodyWidth) break;
    const stripped = stripWidth(ctx.lines[j], bodyWidth);
    body.push(stripped.text);
    columns.push(colAt(ctx, j, stripped.chars));
    j += 1;
  }

  if (body.length === 0 || body.every(isBlank)) {
    // There is no closing marker in this dialect, so "unclosed" means "the indented body
    // that was supposed to follow never arrived".
    report(ctx, 'MD064', i, baseWidth, ctx.lines[i].trim().length,
      `admonition \`${kind}\` has no body`,
      'Indent the admonition content by four spaces on the lines below.');
  }

  let title = null;
  if (tail !== undefined) {
    const quoted = /^(["'])([\s\S]*)\1[ \t]*$/.exec(tail.trim());
    title = quoted ? quoted[2] : tail.trim();
  }

  const collapsible = marker.startsWith('???');
  return {
    node: {
      type: 'admonition',
      line: lineNo(ctx, i),
      column: colAt(ctx, i, baseWidth),
      kind: kind.toLowerCase(),
      title,
      collapsible,
      open: !collapsible || marker === '???+',
      children: body.length ? descend(ctx, i + 1, body, columns) : [],
    },
    next: j,
  };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseBlockquote(ctx, i) {
  if (!BLOCKQUOTE_RE.test(ctx.lines[i])) return null;

  /** @type {string[]} */
  const body = [];
  /** @type {number[]} */
  const columns = [];
  let j = i;
  while (j < ctx.lines.length) {
    const line = ctx.lines[j];
    const marker = /^( {0,3}>)( ?)/.exec(line);
    if (marker) {
      const cut = marker[0].length;
      body.push(line.slice(cut));
      columns.push(colAt(ctx, j, cut));
      j += 1;
      continue;
    }
    // Lazy continuation: a plain paragraph line keeps the quote going.
    if (isBlank(line) || body.length === 0 || isBlank(body[body.length - 1])) break;
    if (interruptsParagraph(ctx, j)) break;
    body.push(line);
    columns.push(colAt(ctx, j));
    j += 1;
  }

  const firstContent = body.findIndex((l) => !isBlank(l));
  const alert = firstContent === -1 ? null : ALERT_RE.exec(body[firstContent]);

  if (alert) {
    const rest = body.slice(firstContent + 1);
    const restCols = columns.slice(firstContent + 1);
    if (rest.every(isBlank)) {
      report(ctx, 'MD064', i + firstContent, 0, body[firstContent].length,
        `alert \`${alert[1].toUpperCase()}\` has no body`,
        'Add the alert text on the following `>` lines.');
    }
    return {
      node: {
        type: 'admonition',
        line: lineNo(ctx, i),
        column: colAt(ctx, i),
        kind: ALERT_KINDS[alert[1].toLowerCase()] ?? alert[1].toLowerCase(),
        title: null,
        collapsible: false,
        open: true,
        children: rest.length ? descend(ctx, i + firstContent + 1, rest, restCols) : [],
      },
      next: j,
    };
  }

  return {
    node: {
      type: 'blockquote',
      line: lineNo(ctx, i),
      column: colAt(ctx, i),
      children: descend(ctx, i, body, columns),
    },
    next: j,
  };
}

/**
 * Collect one list item's body: the marker line's remainder plus every following line
 * indented to the content column (and lazy paragraph continuations).
 * @param {LexContext} ctx
 * @param {number} i
 * @param {{ contentIndent: number }} marker
 * @returns {{ body: string[], columns: number[], next: number, innerBlank: boolean }}
 */
function collectItem(ctx, i, marker) {
  const head = stripWidth(ctx.lines[i], marker.contentIndent);
  const body = [head.text];
  const columns = [colAt(ctx, i, head.chars)];
  let j = i + 1;
  let innerBlank = false;

  while (j < ctx.lines.length) {
    if (isBlank(ctx.lines[j])) {
      let peek = j;
      while (peek < ctx.lines.length && isBlank(ctx.lines[peek])) peek += 1;
      if (peek >= ctx.lines.length
        || measureIndent(ctx.lines[peek]).width < marker.contentIndent) break;
      for (let k = j; k < peek; k += 1) { body.push(''); columns.push(colAt(ctx, k)); }
      innerBlank = true;
      j = peek;
      continue;
    }

    if (measureIndent(ctx.lines[j]).width >= marker.contentIndent) {
      const stripped = stripWidth(ctx.lines[j], marker.contentIndent);
      body.push(stripped.text);
      columns.push(colAt(ctx, j, stripped.chars));
      j += 1;
      continue;
    }

    if (matchListMarker(ctx.lines[j]) || interruptsParagraph(ctx, j)) break;
    // Lazy continuation of the item's last paragraph.
    const stripped = stripWidth(ctx.lines[j], measureIndent(ctx.lines[j]).width);
    body.push(stripped.text);
    columns.push(colAt(ctx, j, stripped.chars));
    j += 1;
  }

  return { body, columns, next: j, innerBlank };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseList(ctx, i) {
  const first = matchListMarker(ctx.lines[i]);
  if (!first) return null;

  const ordered = first.ordered;

  // A nested list should line up with its parent item's content column. Landing on
  // column 4 instead (the classic three-space indent) is the case parsers disagree on.
  if (ctx.inListItem && first.indent > 0 && (colAt(ctx, i, first.indent) - 1) % 4 === 3) {
    report(ctx, 'MD062', i, 0, first.indent + 1, 'list item indentation is ambiguous',
      'Indent a nested list to its parent item\'s text column (2 spaces under `-`, 3 under `1.`).');
  }

  /** @type {object[]} */
  const items = [];
  /** @type {Array<{ number: number, idx: number }>} */
  const numbers = [];
  let marker = first.marker;
  let loose = false;
  let j = i;

  while (j < ctx.lines.length) {
    // Blank lines between items keep the list going -- and make it loose.
    let probe = j;
    while (probe < ctx.lines.length && isBlank(ctx.lines[probe])) probe += 1;
    if (probe >= ctx.lines.length) break;

    const mk = matchListMarker(ctx.lines[probe]);
    if (!mk || mk.ordered !== ordered) break;
    // A marker indented past the first item's content column belongs to a nested list,
    // which `collectItem` already consumed; anything else ends this list.
    if (mk.indent >= first.contentIndent || mk.indent < first.indent) break;

    if (probe > j) loose = true;
    j = probe;

    if (mk.indent !== first.indent || mk.hasTab) {
      report(ctx, 'MD062', j, 0, mk.indent + 1, 'list item indentation is ambiguous',
        `Align this marker with the first item at column ${colAt(ctx, i, first.indent)}, using spaces.`);
    }
    if (mk.marker !== marker) {
      report(ctx, 'MD060', j, mk.indent, 1,
        `list marker \`${mk.marker}\` does not match \`${marker}\``,
        `Use \`${marker}\` for every item in this list.`);
      marker = mk.marker;
    }
    if (ordered) numbers.push({ number: mk.number, idx: j });

    const collected = collectItem(ctx, j, mk);
    let checked = null;
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(collected.body[0]);
    if (task) {
      checked = task[1] !== ' ';
      collected.body[0] = collected.body[0].slice(task[0].length);
      collected.columns[0] += task[0].length;
    }

    if (collected.innerBlank) loose = true;

    items.push({
      type: 'listItem',
      line: lineNo(ctx, j),
      column: colAt(ctx, j, mk.indent),
      checked,
      children: descend(ctx, j, collected.body, collected.columns, true),
    });
    j = collected.next;
  }

  if (items.length === 0) return null;

  if (ordered && numbers.length > 1) {
    const allSame = numbers.every((n) => n.number === numbers[0].number);
    if (!allSame) {
      for (let k = 1; k < numbers.length; k += 1) {
        if (numbers[k].number === numbers[0].number + k) continue;
        report(ctx, 'MD061', numbers[k].idx, 0, String(numbers[k].number).length,
          `expected \`${numbers[0].number + k}.\`, found \`${numbers[k].number}.\``,
          'Number the items sequentially, or use `1.` for every item and let the renderer count.');
        break;
      }
    }
  }

  return {
    node: {
      type: 'list',
      line: lineNo(ctx, i),
      column: colAt(ctx, i, first.indent),
      ordered,
      start: ordered ? first.number : 1,
      tight: !loose,
      children: items,
    },
    next: j,
  };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseTable(ctx, i) {
  const header = ctx.lines[i];
  if (!header.includes('|')) return null;
  const delimiterLine = ctx.lines[i + 1];
  if (delimiterLine === undefined || !isDelimiterRow(delimiterLine)) return null;

  const headerCells = splitCells(header);
  const delimiterCells = splitCells(delimiterLine);
  if (headerCells.length === 0) return null;

  if (delimiterCells.length !== headerCells.length) {
    report(ctx, 'MD032', i + 1, 0, delimiterLine.trim().length,
      `delimiter row has ${delimiterCells.length} cells but the header has ${headerCells.length}`,
      'Give the delimiter row one `---` cell per header column.');
  }

  /** @type {Array<'left'|'center'|'right'|null>} */
  const align = [];
  for (let c = 0; c < headerCells.length; c += 1) {
    const cell = delimiterCells[c];
    if (!cell || !/^:?-+:?$/.test(cell.text)) {
      if (cell) {
        report(ctx, 'MD032', i + 1, cell.offset, Math.max(1, cell.text.length),
          `\`${cell.text}\` is not a valid alignment cell`,
          'Use `---`, `:--`, `--:` or `:-:`.');
      }
      align.push(null);
      continue;
    }
    const left = cell.text.startsWith(':');
    const right = cell.text.endsWith(':');
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }

  /**
   * @param {number} idx
   * @param {{ text: string, offset: number }} cell
   */
  const toCell = (idx, cell) => ({
    children: inline(ctx, idx, cell.text, [colAt(ctx, idx, cell.offset)]),
    line: lineNo(ctx, idx),
    column: colAt(ctx, idx, cell.offset),
  });

  /** @type {object[][]} */
  const rows = [];
  let j = i + 2;
  while (j < ctx.lines.length) {
    const line = ctx.lines[j];
    if (isBlank(line) || !line.includes('|') || interruptsParagraph(ctx, j)) break;
    const cells = splitCells(line);
    if (cells.length !== headerCells.length) {
      report(ctx, 'MD031', j, 0, line.trim().length,
        `row has ${cells.length} cells, the header has ${headerCells.length}`,
        'Add or remove cells so every row lines up, escaping literal pipes as `\\|`.');
    }
    rows.push(cells.slice(0, headerCells.length).map((cell) => toCell(j, cell)));
    j += 1;
  }

  return {
    node: {
      type: 'table',
      line: lineNo(ctx, i),
      column: colAt(ctx, i),
      align,
      header: headerCells.map((cell) => toCell(i, cell)),
      rows,
    },
    next: j,
  };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseHtmlBlock(ctx, i) {
  const line = ctx.lines[i];
  if (!startsHtmlBlock(line)) return null;

  let j = i;
  if (HTML_COMMENT_OPEN.test(line)) {
    while (j < ctx.lines.length && !ctx.lines[j].includes('-->')) j += 1;
    j = Math.min(j + 1, ctx.lines.length);
  } else {
    const raw = HTML_RAW_OPEN.exec(line);
    if (raw) {
      const closer = new RegExp(`</${raw[1]}\\s*>`, 'i');
      while (j < ctx.lines.length && !closer.test(ctx.lines[j])) j += 1;
      j = Math.min(j + 1, ctx.lines.length);
    } else {
      while (j < ctx.lines.length && !isBlank(ctx.lines[j])) j += 1;
    }
  }

  return {
    node: {
      type: 'html',
      line: lineNo(ctx, i),
      column: colAt(ctx, i),
      value: ctx.lines.slice(i, j).join('\n'),
    },
    next: j,
  };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseFootnoteDefinition(ctx, i) {
  const m = FOOTNOTE_DEF_RE.exec(ctx.lines[i]);
  if (!m) return null;
  const [, indentStr, identifier, firstLine] = m;
  const contentIndent = indentStr.length + 4;
  const headOffset = ctx.lines[i].length - firstLine.length;

  const body = [firstLine];
  const columns = [colAt(ctx, i, headOffset)];
  let j = i + 1;
  while (j < ctx.lines.length) {
    if (isBlank(ctx.lines[j])) {
      let peek = j;
      while (peek < ctx.lines.length && isBlank(ctx.lines[peek])) peek += 1;
      if (peek >= ctx.lines.length || measureIndent(ctx.lines[peek]).width < contentIndent) break;
      for (let k = j; k < peek; k += 1) { body.push(''); columns.push(colAt(ctx, k)); }
      j = peek;
      continue;
    }
    if (measureIndent(ctx.lines[j]).width < contentIndent) break;
    const stripped = stripWidth(ctx.lines[j], contentIndent);
    body.push(stripped.text);
    columns.push(colAt(ctx, j, stripped.chars));
    j += 1;
  }

  return {
    node: {
      type: 'footnoteDefinition',
      line: lineNo(ctx, i),
      column: colAt(ctx, i, indentStr.length),
      identifier,
      children: descend(ctx, i, body, columns),
    },
    next: j,
  };
}

/**
 * Link reference definition: `[label]: destination "title"`, with the title allowed to
 * spill onto the next line.
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }|null}
 */
function parseLinkDefinition(ctx, i) {
  const m = LINK_DEF_RE.exec(ctx.lines[i]);
  if (!m) return null;
  const [, indentStr, label, tail] = m;
  if (label.startsWith('^')) return null;

  const rest = tail.trim();
  if (rest === '') return null;

  let url = '';
  let cursor = 0;
  if (rest[0] === '<') {
    const close = rest.indexOf('>');
    if (close === -1) return null;
    url = rest.slice(1, close);
    cursor = close + 1;
  } else {
    while (cursor < rest.length && !/\s/.test(rest[cursor])) cursor += 1;
    url = rest.slice(0, cursor);
  }
  if (url === '') return null;

  let title = null;
  let next = i + 1;
  let titleSource = rest.slice(cursor).trim();
  if (titleSource === '' && next < ctx.lines.length) {
    const candidate = ctx.lines[next].trim();
    if (/^(["'(])[\s\S]*(["')])$/.test(candidate)) { titleSource = candidate; next += 1; }
  }
  if (titleSource !== '') {
    const quoted = /^(["'(])([\s\S]*)(["')])$/.exec(titleSource);
    if (!quoted) return null; // trailing junk -- this is a paragraph, not a definition
    title = quoted[2];
  }

  return {
    node: {
      type: 'definition',
      line: lineNo(ctx, i),
      column: colAt(ctx, i, indentStr.length),
      identifier: normalizeLabel(label),
      url,
      title,
    },
    next,
  };
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }}
 */
function parseIndentedCode(ctx, i) {
  const body = [];
  let j = i;
  let lastContent = i;
  while (j < ctx.lines.length) {
    if (isBlank(ctx.lines[j])) { body.push(''); j += 1; continue; }
    if (measureIndent(ctx.lines[j]).width < 4) break;
    body.push(stripWidth(ctx.lines[j], 4).text);
    lastContent = j;
    j += 1;
  }
  return {
    node: {
      type: 'code',
      line: lineNo(ctx, i),
      column: colAt(ctx, i),
      lang: null,
      meta: null,
      value: body.slice(0, lastContent - i + 1).join('\n'),
      fenced: false,
    },
    next: lastContent + 1,
  };
}

/**
 * Does the line at `i` end an open paragraph?
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {boolean}
 */
function interruptsParagraph(ctx, i) {
  const line = ctx.lines[i];
  if (line === undefined) return true;
  if (isBlank(line)) return true;
  if (measureIndent(line).width >= 4) return false;
  if (ATX_RE.test(line)) return true;
  if (FENCE_OPEN_RE.test(line)) return true;
  if (BLOCKQUOTE_RE.test(line)) return true;
  if (THEMATIC_RE.test(line)) return true;
  if (MKDOCS_RE.test(line)) return true;
  if (startsHtmlBlock(line)) return true;
  if (line.includes('|') && isDelimiterRow(ctx.lines[i + 1] ?? '')) return true;
  const mk = matchListMarker(line);
  // Only a `1.`-numbered, non-empty item may cut a paragraph in half.
  if (mk && !isBlank(stripWidth(line, mk.contentIndent).text) && (!mk.ordered || mk.number === 1)) {
    return true;
  }
  return false;
}

/**
 * @param {LexContext} ctx
 * @param {number} i
 * @returns {{ node: object, next: number }}
 */
function parseParagraph(ctx, i) {
  /** @type {string[]} */
  const body = [];
  /** @type {number[]} */
  const columns = [];
  let j = i;
  let setext = 0;

  while (j < ctx.lines.length) {
    const line = ctx.lines[j];
    if (isBlank(line)) break;
    if (body.length > 0) {
      const underline = SETEXT_RE.exec(line);
      if (underline) { setext = underline[1][0] === '=' ? 1 : 2; j += 1; break; }
      if (interruptsParagraph(ctx, j)) break;
    }
    const indent = measureIndent(line);
    body.push(line.slice(indent.chars));
    columns.push(colAt(ctx, j, indent.chars));
    j += 1;
  }

  if (looksLikeTableRow(body[0] ?? '')) {
    report(ctx, 'MD030', i, 0, body[0].length, 'table is missing its delimiter row',
      'Add a row like `|---|---|` directly beneath the header row.');
  }

  const text = body.join('\n');
  const children = inline(ctx, i, text, columns);

  if (setext > 0) {
    const plain = inlineToText(children);
    return {
      node: {
        type: 'heading',
        line: lineNo(ctx, i),
        column: columns[0] ?? colAt(ctx, i),
        depth: setext,
        children,
        id: slugify(plain),
        text: plain,
      },
      next: j,
    };
  }

  return {
    node: {
      type: 'paragraph',
      line: lineNo(ctx, i),
      column: columns[0] ?? colAt(ctx, i),
      children,
    },
    next: j,
  };
}

/**
 * @param {LexContext} ctx
 * @returns {object[]}
 */
function parseBlocks(ctx) {
  /** @type {object[]} */
  const out = [];
  let i = 0;

  while (i < ctx.lines.length) {
    const line = ctx.lines[i];
    if (isBlank(line)) { i += 1; continue; }

    /** @type {{ node: object, next: number }|null} */
    let result = null;

    if (measureIndent(line).width >= 4) {
      result = parseIndentedCode(ctx, i);
    } else {
      result = parseFence(ctx, i)
        || parseAtxHeading(ctx, i)
        || (THEMATIC_RE.test(line)
          ? { node: { type: 'thematicBreak', line: lineNo(ctx, i), column: colAt(ctx, i) }, next: i + 1 }
          : null)
        || parseMkdocsAdmonition(ctx, i)
        || parseBlockquote(ctx, i)
        || parseHtmlBlock(ctx, i)
        || parseFootnoteDefinition(ctx, i)
        || parseLinkDefinition(ctx, i)
        || parseList(ctx, i)
        || parseTable(ctx, i)
        || parseParagraph(ctx, i);
    }

    out.push(result.node);
    // Every branch must consume at least one line; a malformed document must not spin.
    i = result.next > i ? result.next : i + 1;
  }

  return out;
}

/**
 * Scan Markdown source into block nodes.
 *
 * @param {string} source
 * @param {Object} [options]
 * @param {number} [options.startLine] 1-based source line of the first line of `source`
 * @param {{ add: Function }|null} [options.bag] diagnostic collector
 * @param {object} [options.config] normalised config (reserved for future block options)
 * @param {Map<string, { url: string, title: string|null }>} [options.definitions] link
 *   reference definitions from the parser's first pass, used to resolve `[x][y]`
 * @param {number[]|null} [options.lineColumns] source start column of each line; set by
 *   container blocks so nested positions stay exact
 * @param {boolean} [options.scanWhitespace] run the MD063/MD065 prescan (top level only)
 * @param {boolean} [options.inListItem] set when recursing into a list item's body
 * @returns {object[]} Block nodes
 */
export function tokenizeBlocks(source, options = {}) {
  const {
    startLine = 1,
    bag = null,
    config = {},
    definitions = new Map(),
    lineColumns = null,
    scanWhitespace = true,
    inListItem = false,
    containerDepth = 0,
  } = options;

  /** @type {LexContext} */
  const ctx = {
    lines: String(source).split('\n'),
    startLine,
    bag,
    config,
    definitions,
    cols: lineColumns,
    inListItem,
    containerDepth,
  };

  if (scanWhitespace) reportWhitespace(ctx);
  return parseBlocks(ctx);
}
