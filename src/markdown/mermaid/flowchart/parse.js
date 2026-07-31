/**
 * Mermaid `graph` / `flowchart` source -> {@link FlowGraph}.
 *
 * The grammar is line-oriented: a line holds one or more `;`-separated statements, and a
 * statement is either a keyword form (`subgraph`, `end`, `direction`, `classDef`, `class`,
 * `click`, `style`, `linkStyle`) or a chain of node groups joined by links. Hence a
 * hand-written recursive-descent parser with a small link tokenizer rather than one big
 * regex: mermaid's link syntax is context-sensitive -- the very same `--` *opens* a
 * labelled link when two dashes precede the text and *closes* one afterwards, while `---`
 * is a plain open link -- and any regex that tries to cover that starts eating labels
 * containing punctuation.
 *
 * Nothing here throws and nothing here loops without a bound. A malformed statement
 * produces MD081 and is skipped, so one typo costs the reader a line, never the diagram
 * and never the build.
 *
 * @module markdown/mermaid/flowchart/parse
 */

import { RULES, SEVERITIES } from '../../diagnostics.js';

/**
 * Severities used until MD080-MD084 land in the shared registry. `RULES` wins the moment
 * the codes are registered there, so this table can only ever be a temporary stand-in.
 * @type {Readonly<Record<string, 'error'|'warning'|'info'>>}
 */
const FALLBACK_SEVERITY = Object.freeze({
  MD080: 'info',
  MD081: 'error',
  MD082: 'warning',
  MD083: 'info',
  MD084: 'warning',
});

/** Shape names a `FlowNode.shape` may carry. Layout and render key off these. */
export const NODE_SHAPES = Object.freeze([
  'rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle',
  'diamond', 'hexagon', 'parallelogram', 'parallelogram-alt', 'flag',
]);

/** Edge kinds a `FlowEdge.kind` may carry. */
export const EDGE_KINDS = Object.freeze(['arrow', 'open', 'dotted', 'thick', 'cross', 'circle']);

/**
 * Node shape delimiters, longest opener first -- `[[` must be tried before `[` or
 * `A[[Text]]` parses as a rect whose label starts with a bracket.
 *
 * `nest` is off for the flag shape because its opener is a single `>`, which appears in
 * labels far too often to count as nesting. `closers` lists every accepted terminator:
 * mermaid's trapezoids (`[/Text\]`, `[\Text/]`) are not in the supported shape set, and
 * degrading them to the parallelogram they most resemble beats failing the whole diagram.
 */
const SHAPE_DELIMITERS = Object.freeze([
  { open: '([', closers: ['])'], shape: 'stadium', nest: true },
  { open: '[[', closers: [']]'], shape: 'subroutine', nest: true },
  { open: '[(', closers: [')]'], shape: 'cylinder', nest: true },
  { open: '[/', closers: ['/]', '\\]'], shape: 'parallelogram', nest: false },
  { open: '[\\', closers: ['\\]', '/]'], shape: 'parallelogram-alt', nest: false },
  { open: '((', closers: ['))'], shape: 'circle', nest: true },
  { open: '{{', closers: ['}}'], shape: 'hexagon', nest: true },
  { open: '[', closers: [']'], shape: 'rect', nest: true },
  { open: '(', closers: [')'], shape: 'round', nest: true },
  { open: '{', closers: ['}'], shape: 'diamond', nest: true },
  { open: '>', closers: [']'], shape: 'flag', nest: false },
]);

/** `TB` is mermaid's synonym for `TD`; the model carries one spelling. */
const DIRECTIONS = Object.freeze({ TD: 'TD', TB: 'TD', BT: 'BT', LR: 'LR', RL: 'RL' });

/** Character references worth decoding in a label. Everything else stays literal. */
const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
});

/**
 * Ceilings. These are deliberately far above the renderable limits in the spec (300 nodes,
 * 600 edges) -- exceeding *those* is index.js's call. These exist so a pathological or
 * adversarial fence terminates, and hitting one is reported as MD084.
 */
const MAX_LINES = 20000;
const MAX_STATEMENTS_PER_LINE = 128;
const MAX_NODES = 4000;
const MAX_EDGES = 8000;
const MAX_SUBGRAPH_DEPTH = 32;
const MAX_CHAIN = 512;
const MAX_GROUP = 128;

/** Returned by a reader that consumed input but could not make sense of it. */
const INVALID = Symbol('invalid');

/** @typedef {'TD'|'BT'|'LR'|'RL'} FlowDirection */

/**
 * @typedef {Object} FlowNode
 * @property {string} id
 * @property {string[]} label one entry per rendered line (`<br/>` splits them)
 * @property {string} shape one of {@link NODE_SHAPES}
 * @property {string[]} classes bare `classDef` names; the renderer prefixes `node--`
 * @property {number} line 1-based line in the containing document
 */

/**
 * @typedef {Object} FlowEdge
 * @property {string} from
 * @property {string} to
 * @property {'arrow'|'open'|'dotted'|'thick'|'cross'|'circle'} kind
 * @property {string[]|null} label
 * @property {number} line
 * @property {'solid'|'dotted'|'thick'} style stroke family
 * @property {'arrow'|'none'|'cross'|'circle'} arrowhead
 *
 * `style` and `arrowhead` are carried alongside `kind` because `kind` conflates the two:
 * `-.->` and `-.-` are both `dotted`, yet only one of them wants an arrowhead.
 */

/**
 * @typedef {Object} FlowSubgraph
 * @property {string} id
 * @property {string} title
 * @property {string[]} nodeIds direct members, in first-appearance order
 * @property {FlowSubgraph[]} children
 * @property {FlowDirection|null} direction
 * @property {number} line
 * @property {number} column 1-based column of the `subgraph` keyword
 */

/**
 * @typedef {Object} FlowGraph
 * @property {FlowDirection} direction
 * @property {Map<string, FlowNode>} nodes insertion-ordered; layout determinism rests on it
 * @property {FlowEdge[]} edges source order
 * @property {FlowSubgraph[]} subgraphs top level only; nesting lives in `children`
 * @property {Map<string, string>} classDefs raw `classDef` bodies, recorded but not honoured
 */

/**
 * @typedef {Object} ParseContext
 * @property {string} [file] path used on every diagnostic
 * @property {number} [line] 1-based document line of the fence's first content line
 * @property {number} [column] 1-based column the fence body starts at (indented fences)
 * @property {Record<string, string>} [rules] severity overrides, as in `config.rules`
 */

/**
 * Parse mermaid flowchart source.
 *
 * The graph is always returned, however broken the input: partial output plus diagnostics
 * is more useful to an author than nothing, and it lets the caller decide (on severity)
 * whether to render or fall back to a code block.
 *
 * @param {string} source the fence body, verbatim, without the `graph TD` line stripped
 * @param {ParseContext} [ctx]
 * @returns {{ graph: FlowGraph, diagnostics: import('../../diagnostics.js').Diagnostic[] }}
 */
export function parseFlowchart(source, ctx = {}) {
  const state = createState(ctx || {});
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');

  if (lines.length > MAX_LINES) {
    overflow(state, state.lineBase + MAX_LINES, 1,
      `flowchart has more than ${MAX_LINES} lines; the rest was ignored`);
  }

  const limit = Math.min(lines.length, MAX_LINES);
  for (let index = 0; index < limit && !state.aborted; index += 1) {
    const line = state.lineBase + index;
    const text = stripComments(state, lines[index], line);
    if (!text.trim()) continue;

    const statements = splitStatements(text);
    for (let i = 0; i < statements.length && i < MAX_STATEMENTS_PER_LINE; i += 1) {
      if (state.aborted) break;
      handleStatement(state, statements[i].text, line, statements[i].column);
    }
  }

  // After a ceiling breach the tail of the diagram was never read, so an open subgraph is
  // our doing rather than the author's -- reporting it would be a lie.
  if (!state.aborted) {
    for (const open of state.stack) {
      report(state, 'MD081', open.line, open.column,
        `subgraph \`${open.id}\` is never closed`,
        'Close every `subgraph` with a matching `end` line.');
    }
  }
  state.stack.length = 0;

  return { graph: state.graph, diagnostics: state.diagnostics };
}

/**
 * @param {ParseContext} ctx
 * @returns {object} mutable parser state
 */
function createState(ctx) {
  return {
    file: typeof ctx.file === 'string' ? ctx.file : '',
    lineBase: Math.max(1, Number(ctx.line) || 1),
    columnOffset: Math.max(0, (Number(ctx.column) || 1) - 1),
    rules: ctx.rules && typeof ctx.rules === 'object' ? ctx.rules : {},
    /** @type {import('../../diagnostics.js').Diagnostic[]} */
    diagnostics: [],
    /** @type {FlowGraph} */
    graph: {
      direction: 'TD',
      nodes: new Map(),
      edges: [],
      subgraphs: [],
      classDefs: new Map(),
    },
    /** @type {FlowSubgraph[]} open subgraphs, innermost last */
    stack: [],
    /** @type {Set<string>} every subgraph id issued so far */
    subgraphIds: new Set(),
    header: false,
    aborted: false,
    capped: false,
    subgraphSeq: 0,
  };
}

/**
 * @param {string} code
 * @param {Record<string, string>} overrides
 * @returns {string} effective severity, or `'off'`
 */
function resolveSeverity(code, overrides) {
  const override = overrides[code];
  if (typeof override === 'string' && SEVERITIES.has(override)) return override;
  return RULES[code]?.severity ?? FALLBACK_SEVERITY[code] ?? 'warning';
}

/**
 * @param {object} state
 * @param {string} code
 * @param {number} line absolute document line
 * @param {number} column absolute 1-based column
 * @param {string} message
 * @param {string|null} [hint]
 * @param {number} [endColumn]
 */
function report(state, code, line, column, message, hint = null, endColumn = 0) {
  const severity = resolveSeverity(code, state.rules);
  if (severity === 'off') return;
  const col = Math.max(1, column);
  state.diagnostics.push({
    code,
    severity,
    message,
    hint,
    file: state.file,
    line: Math.max(1, line),
    column: col,
    endLine: Math.max(1, line),
    endColumn: Math.max(col + 1, endColumn),
  });
}

/**
 * Report a ceiling breach once and stop parsing. Continuing past a cap would only produce
 * output the caller is going to refuse anyway.
 * @param {object} state
 * @param {number} line
 * @param {number} column
 * @param {string} message
 */
function overflow(state, line, column, message) {
  state.aborted = true;
  if (state.capped) return;
  state.capped = true;
  report(state, 'MD084', line, column, message,
    'Split the diagram into several smaller ones.');
}

// --- Line preparation ------------------------------------------------------------

/**
 * Remove `%%` comments and `%%{init}%%` directives.
 *
 * Directives are blanked rather than cut so that every later column on the line still
 * matches the file the author is looking at.
 *
 * @param {object} state
 * @param {string} raw
 * @param {number} line
 * @returns {string}
 */
function stripComments(state, raw, line) {
  let text = String(raw);
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted || ch !== '%' || text[i + 1] !== '%') continue;

    if (text[i + 2] === '{') {
      const close = text.indexOf('}%%', i + 3);
      const end = close === -1 ? text.length : close + 3;
      report(state, 'MD083', line, state.columnOffset + i + 1,
        '`%%{init}%%` directive ignored',
        'Diagram appearance comes from the site theme, so init options have no effect.',
        state.columnOffset + end + 1);
      text = text.slice(0, i) + ' '.repeat(end - i) + text.slice(end);
      i = end - 1;
      continue;
    }
    return text.slice(0, i);
  }
  return text;
}

/**
 * Split a line into `;`-separated statements, ignoring separators inside quotes or shape
 * delimiters so `A["a;b"]` survives.
 * @param {string} text
 * @returns {Array<{ text: string, column: number }>} column is a 0-based offset into `text`
 */
function splitStatements(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === '[' || ch === '(' || ch === '{') depth += 1;
    else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push({ text: text.slice(start, i), column: start });
      start = i + 1;
    }
  }
  out.push({ text: text.slice(start), column: start });
  return out;
}

// --- Statement dispatch ----------------------------------------------------------

const HEADER_RE = /^(?:graph|flowchart)\b[ \t]*([^\s;]*)/i;
const CLASSDEF_RE = /^classDef[ \t]+([^\s]+)[ \t]*(.*)$/i;
const CLASS_RE = /^class[ \t]+([^\s]+)[ \t]+([^\s]+)[ \t]*$/i;

/**
 * @param {object} state
 * @param {string} rawText
 * @param {number} line
 * @param {number} offset 0-based offset of the statement within its line
 */
function handleStatement(state, rawText, line, offset) {
  const leading = rawText.length - rawText.replace(/^\s+/, '').length;
  const body = rawText.trim();
  if (!body) return;

  // Absolute 0-based column of `body[0]`; every reader adds its own position to this.
  const base = state.columnOffset + offset + leading;
  const column = base + 1;

  if (!state.header) {
    state.header = true;
    const header = HEADER_RE.exec(body);
    if (header) {
      applyHeader(state, header, line, base);
      return;
    }
    report(state, 'MD081', line, column,
      'flowchart does not start with `graph` or `flowchart`',
      'Begin the diagram with `graph TD`, or `flowchart LR` for a left-to-right layout.',
      column + body.length);
    // Fall through: the statement may still be a perfectly good edge.
  }

  if (/^end\b/i.test(body)) return closeSubgraph(state, line, column);
  if (/^subgraph\b/i.test(body)) return openSubgraph(state, body, line, base);
  if (/^direction\b/i.test(body)) return applyDirection(state, body, line, base);
  if (CLASSDEF_RE.test(body)) return applyClassDef(state, body, line, column);
  if (CLASS_RE.test(body)) return applyClass(state, body, line, column);

  // Recognised and deliberately ignored: appearance is the stylesheet's job, and
  // `click` targets are not emitted at all (no JavaScript ships with a diagram).
  if (/^(?:click|linkStyle)\b/i.test(body) || /^style[ \t]/i.test(body)) return;

  parseChain(state, { text: body, pos: 0, base }, line);
}

/**
 * @param {object} state
 * @param {RegExpExecArray} header
 * @param {number} line
 * @param {number} base
 */
function applyHeader(state, header, line, base) {
  const token = header[1] || '';
  if (!token) return;
  const direction = DIRECTIONS[token.toUpperCase()];
  if (direction) {
    state.graph.direction = direction;
    return;
  }
  const column = base + (header[0].length - token.length) + 1;
  report(state, 'MD081', line, column,
    `unknown flowchart direction \`${token}\``,
    'Expected one of `TD`, `TB`, `BT`, `LR` or `RL`. Falling back to `TD`.',
    column + token.length);
}

/**
 * `direction` inside a subgraph re-orients that box only; at the top level it is another
 * way of writing the header direction.
 * @param {object} state
 * @param {string} body
 * @param {number} line
 * @param {number} base
 */
function applyDirection(state, body, line, base) {
  const match = /^direction\b[ \t]*(\S*)/i.exec(body);
  const token = match?.[1] || '';
  const direction = DIRECTIONS[token.toUpperCase()];
  if (!direction) {
    const column = base + (match ? match[0].length - token.length : 0) + 1;
    report(state, 'MD081', line, column,
      token ? `unknown direction \`${token}\`` : 'expected a direction after `direction`',
      'Expected one of `TD`, `TB`, `BT`, `LR` or `RL`.',
      column + Math.max(1, token.length));
    return;
  }
  const current = state.stack[state.stack.length - 1];
  if (current) current.direction = direction;
  else state.graph.direction = direction;
}

/**
 * @param {object} state
 * @param {string} body
 * @param {number} line
 * @param {number} base 0-based column of `body[0]`
 */
function openSubgraph(state, body, line, base) {
  if (state.stack.length >= MAX_SUBGRAPH_DEPTH) {
    overflow(state, line, base + 1,
      `subgraphs nest more than ${MAX_SUBGRAPH_DEPTH} deep`);
    return;
  }

  const tail = body.replace(/^subgraph\b/i, '');
  const rest = tail.trim();
  // Keep diagnostics pointing at the title, not at the keyword.
  const restBase = base + (body.length - tail.length) + (tail.length - tail.replace(/^\s+/, '').length);
  let id = '';
  let title = '';

  if (rest) {
    const scan = { text: rest, pos: 0, base: restBase };
    const ident = readId(scan);
    skipSpace(scan);
    const shaped = ident ? readShape(state, scan, line) : null;
    if (ident && shaped && shaped !== INVALID) {
      id = ident;
      title = toLabelLines(shaped.body).join(' ');
    } else {
      title = toLabelLines(rest).join(' ');
    }
  }

  if (!id) id = cssName(title);
  // Ids address a box in the layout, so they have to be unique even when two subgraphs
  // share a title -- which is common when the title is the only thing the author wrote.
  if (!id || state.subgraphIds.has(id)) {
    state.subgraphSeq += 1;
    id = `${id || 'subgraph'}-${state.subgraphSeq}`;
  }
  state.subgraphIds.add(id);

  /** @type {FlowSubgraph} */
  const subgraph = {
    id,
    // Deliberately empty for an anonymous subgraph: the renderer omits the title band
    // rather than printing a synthesised id at the reader.
    title,
    nodeIds: [],
    children: [],
    direction: null,
    line,
    column: base + 1,
  };

  const parent = state.stack[state.stack.length - 1];
  if (parent) parent.children.push(subgraph);
  else state.graph.subgraphs.push(subgraph);
  state.stack.push(subgraph);
}

/**
 * @param {object} state
 * @param {number} line
 * @param {number} column
 */
function closeSubgraph(state, line, column) {
  if (!state.stack.length) {
    report(state, 'MD081', line, column,
      '`end` without a matching `subgraph`',
      'Remove it, or open a `subgraph` above it.',
      column + 3);
    return;
  }
  state.stack.pop();
}

/**
 * Record a `classDef` without honouring it: raw `fill:`/`stroke:` values would defeat the
 * whole point of theme-aware diagrams, so the name becomes a CSS hook instead.
 * @param {object} state
 * @param {string} body
 * @param {number} line
 * @param {number} column
 */
function applyClassDef(state, body, line, column) {
  const match = CLASSDEF_RE.exec(body);
  if (!match) return;
  const names = match[1].split(',').map(cssName).filter(Boolean);
  const style = match[2].trim();
  if (!names.length) {
    report(state, 'MD081', line, column, 'expected a class name after `classDef`',
      'Write `classDef danger fill:#f00` and style `.node--danger` in your CSS.',
      column + body.length);
    return;
  }
  for (const name of names) state.graph.classDefs.set(name, style);
  if (!style) return;
  report(state, 'MD083', line, column,
    `\`classDef\` style values are ignored; \`${names[0]}\` becomes the CSS class \`node--${names[0]}\``,
    `Style it in your stylesheet: \`.diagram .node--${names[0]} { --dg-node-bg: … }\`.`,
    column + body.length);
}

/**
 * @param {object} state
 * @param {string} body
 * @param {number} line
 * @param {number} column
 */
function applyClass(state, body, line, column) {
  const match = CLASS_RE.exec(body);
  if (!match) return;
  const ids = match[1].split(',').map((id) => id.trim()).filter(Boolean);
  const names = match[2].split(',').map(cssName).filter(Boolean);
  for (const id of ids) {
    let node = state.graph.nodes.get(id);
    if (!node) {
      report(state, 'MD082', line, column,
        `\`class\` refers to undeclared node \`${id}\``,
        `Declare it first, for example \`${id}[Label]\`.`,
        column + body.length);
      node = ensureNode(state, id, line, column);
      if (!node) return;
    }
    for (const name of names) if (!node.classes.includes(name)) node.classes.push(name);
  }
}

// --- Node / edge statements ------------------------------------------------------

/**
 * `group (link group)*` -- the whole of mermaid's edge syntax, chains and `&` included.
 * @param {object} state
 * @param {{ text: string, pos: number, base: number }} scan
 * @param {number} line
 */
function parseChain(state, scan, line) {
  let previous = readGroup(state, scan, line);
  if (previous === INVALID) return;
  if (!previous) {
    report(state, 'MD081', line, columnAt(scan, scan.pos),
      `unparseable line: expected a node id, got \`${preview(scan.text.slice(scan.pos))}\``,
      'A statement looks like `A[Label] --> B`, `subgraph Name`, `end` or `classDef …`.',
      columnAt(scan, scan.text.length));
    return;
  }

  for (let guard = 0; ; guard += 1) {
    if (guard > MAX_CHAIN) {
      overflow(state, line, columnAt(scan, scan.pos), `more than ${MAX_CHAIN} links in one statement`);
      return;
    }
    skipSpace(scan);
    if (scan.pos >= scan.text.length) return;

    const before = scan.pos;
    const link = readLink(state, scan, line);
    if (link === INVALID) return;
    if (!link) {
      report(state, 'MD081', line, columnAt(scan, scan.pos),
        `unparseable line: expected an edge such as \`-->\`, got \`${preview(scan.text.slice(scan.pos))}\``,
        'Edges are `-->`, `---`, `-.->`, `==>`, `--x` or `--o`, optionally labelled `-->|text|`.',
        columnAt(scan, scan.text.length));
      return;
    }

    const next = readGroup(state, scan, line);
    if (next === INVALID) return;
    if (!next) {
      report(state, 'MD081', line, columnAt(scan, scan.pos),
        'expected a node id after the edge',
        'Every edge needs a target: `A --> B`.',
        columnAt(scan, scan.text.length));
      return;
    }

    for (const from of previous) {
      for (const to of next) {
        if (!addEdge(state, from, to, link, line)) return;
      }
    }
    previous = next;

    // Insurance: every reader above advances on success, but a future edit must not be
    // able to turn this into a spin.
    if (scan.pos <= before) return;
  }
}

/**
 * `nodeRef ('&' nodeRef)*`. Nodes are materialised as they are read so that
 * `graph.nodes` follows source order exactly.
 * @param {object} state
 * @param {{ text: string, pos: number, base: number }} scan
 * @param {number} line
 * @returns {string[]|null|symbol} the ids in the group
 */
function readGroup(state, scan, line) {
  /** @type {string[]} */
  const ids = [];
  for (let guard = 0; ; guard += 1) {
    if (guard > MAX_GROUP) {
      overflow(state, line, columnAt(scan, scan.pos), `more than ${MAX_GROUP} nodes joined by \`&\``);
      return INVALID;
    }

    const ref = readNodeRef(state, scan, line);
    if (ref === INVALID) return INVALID;
    if (!ref) {
      if (!ids.length) return null;
      report(state, 'MD081', line, columnAt(scan, scan.pos),
        'expected a node id after `&`',
        'Multi-target edges look like `A --> B & C`.',
        columnAt(scan, scan.text.length));
      return INVALID;
    }

    if (!applyRef(state, ref, line)) return INVALID;
    ids.push(ref.id);

    skipSpace(scan);
    if (scan.text[scan.pos] !== '&') return ids;
    scan.pos += 1;
  }
}

/**
 * `id [shape] [':::' class]`
 * @param {object} state
 * @param {{ text: string, pos: number, base: number }} scan
 * @param {number} line
 * @returns {{ id: string, shape: string|null, label: string|null, classes: string[], column: number }|null|symbol}
 */
function readNodeRef(state, scan, line) {
  skipSpace(scan);
  const start = scan.pos;
  const id = readId(scan);
  if (!id) {
    scan.pos = start;
    return null;
  }

  const ref = { id, shape: null, label: null, classes: [], column: columnAt(scan, start) };

  const shaped = readShape(state, scan, line);
  if (shaped === INVALID) return INVALID;
  if (shaped) {
    ref.shape = shaped.shape;
    ref.label = shaped.body;
  }

  if (scan.text.startsWith(':::', scan.pos)) {
    const at = columnAt(scan, scan.pos);
    scan.pos += 3;
    const name = cssName(readId(scan));
    if (!name) {
      report(state, 'MD081', line, at, 'expected a class name after `:::`',
        'Write `A:::danger` and define `classDef danger …`.', at + 3);
      return INVALID;
    }
    ref.classes.push(name);
  }

  return ref;
}

/**
 * Read a shape delimiter and its raw body, if one starts at the cursor.
 * @param {object} state
 * @param {{ text: string, pos: number, base: number }} scan
 * @param {number} line
 * @returns {{ shape: string, body: string }|null|symbol}
 */
function readShape(state, scan, line) {
  const { text } = scan;
  for (const def of SHAPE_DELIMITERS) {
    if (!text.startsWith(def.open, scan.pos)) continue;

    const start = scan.pos + def.open.length;
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"') { quoted = !quoted; continue; }
      if (quoted) continue;

      const closer = def.closers.find((c) => text.startsWith(c, i));
      if (closer) {
        if (depth === 0) {
          const body = text.slice(start, i);
          scan.pos = i + closer.length;
          return { shape: def.shape, body };
        }
        depth -= 1;
        i += closer.length - 1;
        continue;
      }
      if (def.nest && text.startsWith(def.open, i)) {
        depth += 1;
        i += def.open.length - 1;
      }
    }

    const at = columnAt(scan, scan.pos);
    report(state, 'MD081', line, at,
      `node shape is never closed: expected \`${def.closers[0]}\``,
      'Wrap label text in double quotes if it contains brackets.',
      columnAt(scan, text.length));
    scan.pos = text.length;
    return INVALID;
  }
  return null;
}

/** Arrowheads that may terminate a link. */
const HEADS = Object.freeze({ '>': 'arrow', x: 'cross', o: 'circle' });

/**
 * The link tokenizer.
 *
 * Mermaid distinguishes the forms by run length: `--` opens a labelled link, `---` is a
 * plain open link, and anything with a trailing `>`/`x`/`o` is complete on its own. Same
 * rule for `==`/`===` and for `-.`/`-.-`.
 *
 * @param {object} state
 * @param {{ text: string, pos: number, base: number }} scan
 * @param {number} line
 * @returns {{ kind: string, style: string, arrowhead: string, label: string[]|null }|null|symbol}
 */
function readLink(state, scan, line) {
  skipSpace(scan);
  const { text } = scan;
  const start = scan.pos;
  let i = start;

  // `<-->` and friends: the reverse head is accepted but not modelled -- a second
  // arrowhead is a rendering nicety, and pretending to support it would be worse.
  if (text[i] === '<') i += 1;

  let style = null;
  let head = 'none';
  let labelled = false;

  if (text[i] === '=') {
    const run = runLength(text, i, '=');
    i += run;
    style = 'thick';
    head = HEADS[text[i]] || 'none';
    if (head !== 'none') i += 1;
    else if (run === 2) labelled = true;
    else if (run < 3) { scan.pos = start; return null; }
  } else if (text[i] === '-') {
    const dashes = runLength(text, i, '-');
    i += dashes;
    if (text[i] === '.') {
      i += runLength(text, i, '.');
      const tail = runLength(text, i, '-');
      i += tail;
      style = 'dotted';
      head = HEADS[text[i]] || 'none';
      if (head !== 'none') i += 1;
      else if (tail === 0) labelled = true;
    } else {
      style = 'solid';
      head = HEADS[text[i]] || 'none';
      if (head !== 'none') i += 1;
      else if (dashes === 2) labelled = true;
      else if (dashes < 3) { scan.pos = start; return null; }
    }
  } else {
    scan.pos = start;
    return null;
  }

  /** @type {string|null} */
  let label = null;

  if (labelled) {
    const rest = text.slice(i);
    const closer = findLinkCloser(rest, style);
    if (!closer) {
      const at = columnAt(scan, start);
      report(state, 'MD081', line, at,
        `edge label is never closed: expected \`${style === 'thick' ? '==>' : style === 'dotted' ? '.->' : '-->'}\``,
        'A labelled edge looks like `A -- text --> B` or `A -->|text| B`.',
        columnAt(scan, text.length));
      scan.pos = text.length;
      return INVALID;
    }
    label = rest.slice(0, closer.index);
    head = closer.head;
    i += closer.index + closer.length;
  }

  scan.pos = i;

  if (label === null) {
    skipSpace(scan);
    if (scan.text[scan.pos] === '|') {
      const piped = readPipeLabel(scan);
      if (piped === null) {
        const at = columnAt(scan, scan.pos);
        report(state, 'MD081', line, at, 'edge label is never closed: expected `|`',
          'A piped label looks like `A -->|yes| B`.', columnAt(scan, scan.text.length));
        scan.pos = scan.text.length;
        return INVALID;
      }
      label = piped;
    }
  }

  return {
    kind: edgeKind(style, head),
    style,
    arrowhead: head,
    label: label === null ? null : toLabelLines(label),
  };
}

/**
 * Closing halves of a labelled link. Each requires a run of at least two dashes/equals or
 * a dot followed by dashes, which is what keeps a label like `v1.0-beta` intact.
 */
const LINK_CLOSERS = Object.freeze({
  solid: [/-{2,}[>xo]?/],
  thick: [/={2,}[>xo]?/],
  // The second pattern is leniency for `-. text --> B`, which mermaid rejects.
  dotted: [/\.-+[>xo]?/, /-{2,}[>xo]?/],
});

/**
 * @param {string} rest text after the opening half of a labelled link
 * @param {string} style
 * @returns {{ index: number, length: number, head: string }|null}
 */
function findLinkCloser(rest, style) {
  for (const pattern of LINK_CLOSERS[style]) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const last = match[0][match[0].length - 1];
    return { index: match.index, length: match[0].length, head: HEADS[last] || 'none' };
  }
  return null;
}

/**
 * @param {{ text: string, pos: number }} scan cursor sits on the opening `|`
 * @returns {string|null}
 */
function readPipeLabel(scan) {
  const { text } = scan;
  let quoted = false;
  for (let i = scan.pos + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === '|' && !quoted) {
      const body = text.slice(scan.pos + 1, i);
      scan.pos = i + 1;
      return body;
    }
  }
  return null;
}

/**
 * `kind` collapses stroke and arrowhead into one token, so pick the more informative of
 * the two: a cross or circle head is always what the author meant to show.
 * @param {string} style
 * @param {string} head
 * @returns {string}
 */
function edgeKind(style, head) {
  if (head === 'cross' || head === 'circle') return head;
  if (style === 'dotted') return 'dotted';
  if (style === 'thick') return 'thick';
  return head === 'arrow' ? 'arrow' : 'open';
}

// --- Model helpers ---------------------------------------------------------------

/**
 * @param {object} state
 * @param {{ id: string, shape: string|null, label: string|null, classes: string[], column: number }} ref
 * @param {number} line
 * @returns {boolean} false when a ceiling was hit
 */
function applyRef(state, ref, line) {
  const node = ensureNode(state, ref.id, line, ref.column);
  if (!node) return false;
  // A later, explicit declaration wins: `A --> B` then `B[Real label]` is idiomatic.
  if (ref.shape) {
    node.shape = ref.shape;
    node.label = toLabelLines(ref.label ?? '');
  }
  for (const name of ref.classes) if (!node.classes.includes(name)) node.classes.push(name);
  return true;
}

/**
 * Nodes mentioned only in an edge are created on the spot -- that is ordinary mermaid, not
 * a mistake, so it draws no diagnostic.
 * @param {object} state
 * @param {string} id
 * @param {number} line
 * @param {number} column
 * @returns {FlowNode|null}
 */
function ensureNode(state, id, line, column) {
  const existing = state.graph.nodes.get(id);
  if (existing) return existing;
  if (state.graph.nodes.size >= MAX_NODES) {
    overflow(state, line, column, `flowchart has more than ${MAX_NODES} nodes`);
    return null;
  }
  /** @type {FlowNode} */
  const node = { id, label: [id], shape: 'rect', classes: [], line };
  state.graph.nodes.set(id, node);
  const owner = state.stack[state.stack.length - 1];
  if (owner) owner.nodeIds.push(id);
  return node;
}

/**
 * @param {object} state
 * @param {string} from
 * @param {string} to
 * @param {{ kind: string, style: string, arrowhead: string, label: string[]|null }} link
 * @param {number} line
 * @returns {boolean} false when a ceiling was hit
 */
function addEdge(state, from, to, link, line) {
  if (state.graph.edges.length >= MAX_EDGES) {
    overflow(state, line, 1, `flowchart has more than ${MAX_EDGES} edges`);
    return false;
  }
  state.graph.edges.push({
    from,
    to,
    kind: link.kind,
    label: link.label,
    line,
    style: link.style,
    arrowhead: link.arrowhead,
  });
  return true;
}

// --- Text helpers ----------------------------------------------------------------

/** Ids are ASCII word characters plus anything above Latin-1 punctuation. */
const ID_START = /[A-Za-z0-9_¡-￿]/;
const ID_CHAR = /[A-Za-z0-9_.¡-￿]/;

/**
 * @param {{ text: string, pos: number }} scan
 * @returns {string}
 */
function readId(scan) {
  const { text } = scan;
  const start = scan.pos;
  while (scan.pos < text.length) {
    const ch = text[scan.pos];
    if (ID_CHAR.test(ch)) { scan.pos += 1; continue; }
    // A single interior dash belongs to the id (`step-1`); a second one starts a link,
    // and `-.` starts a dotted one.
    if (ch === '-' && scan.pos > start && ID_START.test(text[scan.pos + 1] || '')) {
      scan.pos += 1;
      continue;
    }
    break;
  }
  return text.slice(start, scan.pos);
}

/** @param {{ text: string, pos: number }} scan */
function skipSpace(scan) {
  while (scan.pos < scan.text.length) {
    const ch = scan.text[scan.pos];
    if (ch !== ' ' && ch !== '\t') break;
    scan.pos += 1;
  }
}

/**
 * @param {string} text
 * @param {number} from
 * @param {string} ch
 * @returns {number} length of the run of `ch` starting at `from`
 */
function runLength(text, from, ch) {
  let i = from;
  while (i < text.length && text[i] === ch) i += 1;
  return i - from;
}

/**
 * @param {{ base: number }} scan
 * @param {number} pos
 * @returns {number} absolute 1-based column
 */
function columnAt(scan, pos) {
  return scan.base + pos + 1;
}

/**
 * Split label text into rendered lines.
 *
 * Entities are decoded here, not left for the renderer: the renderer escapes everything it
 * emits, so `&lt;` decoded now round-trips back to `&lt;` in the SVG, whereas leaving it
 * alone would produce `&amp;lt;`.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function toLabelLines(raw) {
  let text = String(raw ?? '').trim();
  // Quotes are mermaid's escape hatch for punctuation that would otherwise close the
  // shape, so they are delimiters rather than content.
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);

  const lines = text
    .split(/<br\s*\/?>/i)
    .map((part) => decodeEntities(part).replace(/[ \t]+/g, ' ').trim());

  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g;

/**
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(ENTITY_RE, (match, name) => {
    if (name[0] !== '#') {
      return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : match;
    }
    const hex = name[1] === 'x' || name[1] === 'X';
    const code = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
    // Lone surrogates and NUL would make the SVG unserialisable, and a C0 control is not a
    // legal XML character either -- `&#11;` must stay the text the author typed rather than
    // become a raw 0x0B in the built page.
    if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match;
    return String.fromCodePoint(code);
  });
}

/**
 * Reduce a `classDef` name to something safe to concatenate into a class attribute.
 * @param {string} name
 * @returns {string}
 */
function cssName(name) {
  return String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {string} text
 * @returns {string} a short, single-line excerpt for a diagnostic message
 */
function preview(text) {
  const trimmed = String(text).trim().replace(/\s+/g, ' ');
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed || 'end of line';
}
