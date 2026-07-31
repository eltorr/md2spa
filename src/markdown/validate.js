/**
 * Structural lint pass over a finished document AST.
 *
 * The lexer and inline scanner report what they can see *while* scanning -- a line at a
 * time, with no forward knowledge. This pass runs once the whole tree exists and answers
 * the questions that need the finished document: is a heading level skipped, is a footnote
 * definition ever referenced, does a link reference definition earn its keep.
 *
 * It never re-does work the scanners already did, with one exception: MD031 (table row
 * arity) is re-checked on the assembled node because the lexer only sees the pipes on a
 * line, not the cells the parser ultimately produced. Anything the scanners already
 * reported at the same code/line/column is dropped before returning, so a shared bag never
 * double-reports.
 *
 * @module markdown/validate
 */

import { createBag } from './diagnostics.js';

/** @typedef {import('./diagnostics.js').Diagnostic} Diagnostic */

/**
 * Hard ceiling on tree depth. A malformed document (or a hand-built AST with a cycle the
 * WeakSet cannot catch, e.g. an array that contains itself) must never hang the build.
 */
const MAX_DEPTH = 200;

/**
 * Codes whose column is not comparable between producers: the lexer anchors a bad table
 * row at the pipe it choked on, this pass anchors it at the first cell. Deduping those on
 * `code|line` alone is the only way the two agree.
 */
const LINE_LEVEL_CODES = new Set(['MD031']);

/**
 * The only frontmatter keys that are type-checked (MD002). Arbitrary user keys are
 * preserved untouched and MUST never warn -- real corpora carry device metadata like
 * `iso_layout` or `fnmode`, and a linter that shouts about them is a linter people disable.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FRONTMATTER_TYPES = Object.freeze({
  title: 'string',
  description: 'string',
  summary: 'string',
  order: 'number',
  nav: 'boolean|string',
  draft: 'boolean',
  toc: 'boolean',
  tags: 'string[]',
  icon: 'string',
  date: 'string',
  redirect_from: 'string[]',
});

const TYPE_LABELS = {
  string: 'a string',
  number: 'a number',
  boolean: 'a boolean',
  'string[]': 'an array of strings',
};

/**
 * True for anything worth descending into: a real AST node, or a bare `TableCell`
 * (`{ children, line, column }`) which the spec gives no `type`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNodeLike(value) {
  return Boolean(value)
    && typeof value === 'object'
    && (typeof (/** @type {any} */ (value).type) === 'string'
      || Array.isArray(/** @type {any} */ (value).children));
}

/**
 * Depth-first walk over any AST shape, in document order.
 *
 * Generic on purpose: it follows every array- or node-valued property, so it copes with
 * `children`, with `table.header` (`TableCell[]`) and with `table.rows` (`TableCell[][]`)
 * without knowing those names. `fn` is called only for real nodes (those carrying a string
 * `type`); cells are traversed through, not reported. Return `false` from `fn` to skip a
 * subtree.
 *
 * Cycles are impossible in parser output but trivial to create in a hand-built fixture, so
 * every object is visited at most once and depth is capped at {@link MAX_DEPTH}.
 *
 * @param {any} node root node (or array-bearing container)
 * @param {(node: any, parent: any, depth: number) => (void|boolean)} fn
 * @param {{ maxDepth?: number }} [options]
 * @returns {void}
 */
export function visit(node, fn, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth)
    ? /** @type {number} */ (options.maxDepth)
    : MAX_DEPTH;
  /** @type {WeakSet<object>} */
  const seen = new WeakSet();

  /**
   * @param {any} current
   * @param {any} parent
   * @param {number} depth
   */
  const walkNode = (current, parent, depth) => {
    if (!current || typeof current !== 'object') return;
    if (depth > maxDepth) return;
    if (seen.has(current)) return;
    seen.add(current);

    if (typeof current.type === 'string' && fn(current, parent, depth) === false) return;

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) walkList(value, current, depth + 1);
      else if (isNodeLike(value)) walkNode(value, current, depth + 1);
    }
  };

  /**
   * @param {any[]} list
   * @param {any} parent
   * @param {number} depth
   */
  const walkList = (list, parent, depth) => {
    if (depth > maxDepth) return;
    for (const item of list) {
      if (Array.isArray(item)) walkList(item, parent, depth + 1);
      else if (isNodeLike(item)) walkNode(item, parent, depth);
    }
  };

  walkNode(node, null, 0);
}

/**
 * Every heading id on a page, in document order, deduplicated.
 *
 * Ids are assigned by the renderer, not the parser, so `headings` (from the render result)
 * is authoritative whenever the caller has it. Falling back to the AST only works for a
 * tree that has already been through `renderHtml`.
 *
 * @param {any} ast document node, may be null when `headings` is supplied
 * @param {Array<{ id?: string }|string>} [headings] `renderHtml().headings`
 * @returns {string[]}
 */
export function collectAnchors(ast, headings) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const push = (id) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  if (Array.isArray(headings)) {
    for (const h of headings) push(typeof h === 'string' ? h : h?.id);
    return out;
  }

  visit(ast, (node) => {
    if (node.type === 'heading') push(node.id);
  });
  return out;
}

/**
 * Run every structural rule over a parsed document.
 *
 * When `bag` is supplied the new diagnostics are absorbed into it *and* returned, already
 * filtered against whatever it held, so callers may use either the return value or the
 * shared bag without counting anything twice.
 *
 * @param {any} ast document node from `parseMarkdown`
 * @param {{
 *   file?: string,
 *   frontmatter?: object|null,
 *   source?: string,
 *   config?: object,
 *   bag?: ReturnType<typeof createBag>|null
 * }} [options]
 * @returns {Diagnostic[]} only the diagnostics this pass added
 */
export function validateDocument(ast, options = {}) {
  const {
    file = '<input>',
    frontmatter = {},
    source = '',
    config = {},
    bag: shared = null,
  } = options;

  // Always collect into a private bag: it keeps "what this pass found" separable from
  // whatever the scanners already put in the shared one.
  const bag = createBag(file, { rules: config.rules || {} });

  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  checkFrontmatter(fm, frontmatterBlock(ast, source), bag);

  const facts = collectFacts(ast);
  checkHeadings(facts.headings, fm, bag);
  checkReferences(facts, bag);
  checkFootnotes(facts, bag);
  checkTables(facts.tables, bag);

  const results = dedupe(bag.list(), shared ? shared.list() : []);
  if (shared) shared.absorb(results);
  return results;
}

/* -------------------------------------------------------------------------- collection */

/**
 * One walk, everything the rules below need.
 * @param {any} ast
 */
function collectFacts(ast) {
  /** @type {any[]} */ const headings = [];
  /** @type {any[]} */ const definitions = [];
  /** @type {any[]} */ const footnoteDefs = [];
  /** @type {any[]} */ const footnoteRefs = [];
  /** @type {any[]} */ const tables = [];
  /** @type {Set<string>} */ const usedRefs = new Set();

  visit(ast, (node) => {
    switch (node.type) {
      case 'heading': headings.push(node); break;
      case 'definition': definitions.push(node); break;
      case 'footnoteDefinition': footnoteDefs.push(node); break;
      case 'footnoteReference': footnoteRefs.push(node); break;
      case 'table': tables.push(node); break;
      default: break;
    }
    // Any node may carry `reference` (links today, reference images if the parser ever
    // keeps them). Checking the property rather than the type keeps MD048 honest.
    if (typeof node.reference === 'string' && node.reference !== '') {
      usedRefs.add(normalizeLabel(node.reference));
    }
  });

  return { headings, definitions, footnoteDefs, footnoteRefs, tables, usedRefs };
}

/* ------------------------------------------------------------------------ frontmatter */

/**
 * Locate the frontmatter block. `parseMarkdown` records it on the document node; the
 * optional `source` override stays supported for callers that only have raw bytes.
 *
 * @param {any} ast
 * @param {string} source
 * @returns {{ text: string, startLine: number }}
 */
function frontmatterBlock(ast, source) {
  if (ast && typeof ast.frontmatterRaw === 'string' && ast.frontmatterRaw !== '') {
    return { text: ast.frontmatterRaw, startLine: ast.frontmatterStartLine || 2 };
  }
  const text = String(source || '');
  if (!text) return { text: '', startLine: 2 };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return { text: '', startLine: 2 };
  const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line));
  return { text: lines.slice(1, close === -1 ? undefined : close).join('\n'), startLine: 2 };
}

/**
 * MD002 -- known keys with the wrong type. Unknown keys are none of our business.
 * @param {object} frontmatter
 * @param {{ text: string, startLine: number }} block frontmatter source, for the caret
 * @param {ReturnType<typeof createBag>} bag
 */
function checkFrontmatter(frontmatter, block, bag) {
  const keys = Object.keys(frontmatter).filter((k) => FRONTMATTER_TYPES[k] !== undefined);
  if (keys.length === 0) return;

  const locations = indexFrontmatterKeys(block);
  for (const key of keys) {
    const value = frontmatter[key];
    // A key written with no value at all is an omission, not a type error.
    if (value === null || value === undefined) continue;

    const spec = FRONTMATTER_TYPES[key];
    if (matchesFrontmatterType(value, spec)) continue;

    bag.add(
      'MD002',
      locations.get(key) || { line: 1, column: 1 },
      `\`${key}\` must be ${describeType(spec)}, got ${typeName(value)}`,
      `Set \`${key}\` to ${describeType(spec)} or remove it - only keys md2spa uses are type-checked.`,
    );
  }
}

/**
 * Map top-level frontmatter keys to their source location, so MD002 lands on the key
 * rather than on line 1.
 * @param {{ text: string, startLine: number }} block
 * @returns {Map<string, { line: number, column: number, endLine: number, endColumn: number }>}
 */
function indexFrontmatterKeys(block) {
  /** @type {Map<string, { line: number, column: number, endLine: number, endColumn: number }>} */
  const map = new Map();
  if (!block || !block.text) return map;

  const lines = String(block.text).split(/\r?\n/);
  const startLine = Number.isFinite(block.startLine) ? block.startLine : 2;
  // Frontmatter is small by construction; the cap only exists so a pathological block
  // cannot turn this into a full-document scan.
  const limit = Math.min(lines.length, 500);
  for (let i = 0; i < limit; i += 1) {
    const match = /^([A-Za-z0-9_.$-]+)[ \t]*:/.exec(lines[i]);
    if (!match || map.has(match[1])) continue;
    map.set(match[1], {
      line: startLine + i,
      column: 1,
      endLine: startLine + i,
      endColumn: 1 + match[1].length,
    });
  }
  return map;
}

/**
 * @param {unknown} value
 * @param {string} spec `'string'`, `'string[]'`, `'boolean|string'`, …
 * @returns {boolean}
 */
function matchesFrontmatterType(value, spec) {
  return spec.split('|').some((type) => {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');
      default: return true;
    }
  });
}

/**
 * @param {string} spec
 * @returns {string}
 */
function describeType(spec) {
  return spec.split('|').map((type) => TYPE_LABELS[type] || `a ${type}`).join(' or ');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string') ? 'an array of strings' : 'an array';
  }
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return `a ${typeof value}`;
}

/* --------------------------------------------------------------------------- headings */

/**
 * MD011 (level skipped), MD012 (second h1), MD013 (no title at all).
 * @param {any[]} headings in document order
 * @param {object} frontmatter
 * @param {ReturnType<typeof createBag>} bag
 */
function checkHeadings(headings, frontmatter, bag) {
  /** deepest level reached so far, not merely the previous one; null until the first heading */
  let established = null;
  let firstH1 = null;

  for (const heading of headings) {
    const depth = clampDepth(heading.depth);

    // Compare against the running maximum: after h1/h2/h3, dropping back to h2 and then
    // going to h4 is a return to an already-established level, not a skip. The first
    // heading has nothing to skip from -- pages whose title comes from frontmatter open
    // at h2 all the time, and that is MD013's question, not this one.
    if (established !== null && depth > established + 1) {
      bag.add(
        'MD011',
        heading,
        `heading level skipped: h${established} is followed by h${depth}`,
        `Use h${established + 1} here, or add the intermediate heading.`,
      );
    }
    if (established === null || depth > established) established = depth;

    if (depth === 1) {
      if (firstH1) {
        bag.add(
          'MD012',
          heading,
          `multiple h1 headings (the first is on line ${firstH1.line ?? 1})`,
          'Keep one h1 as the page title and demote the rest to h2.',
        );
      } else {
        firstH1 = heading;
      }
    }
  }

  if (!firstH1 && !hasFrontmatterTitle(frontmatter)) {
    bag.add(
      'MD013',
      { line: 1, column: 1 },
      'document has no h1 and no frontmatter `title`',
      'Add `# Page title` at the top, or a `title:` key to the frontmatter.',
    );
  }
}

/**
 * Any non-empty title counts, whatever its type -- a wrong type is MD002's business and
 * reporting both for one mistake is noise.
 * @param {object} frontmatter
 * @returns {boolean}
 */
function hasFrontmatterTitle(frontmatter) {
  const title = frontmatter.title;
  if (title === null || title === undefined) return false;
  return typeof title === 'string' ? title.trim() !== '' : true;
}

/**
 * @param {unknown} depth
 * @returns {number}
 */
function clampDepth(depth) {
  const n = Math.trunc(Number(depth));
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, n));
}

/* ------------------------------------------------------------------- link definitions */

/**
 * MD048 -- a link reference definition nothing ever pointed at.
 * @param {{ definitions: any[], usedRefs: Set<string> }} facts
 * @param {ReturnType<typeof createBag>} bag
 */
function checkReferences(facts, bag) {
  for (const def of facts.definitions) {
    const id = normalizeLabel(def.identifier ?? '');
    if (id === '' || facts.usedRefs.has(id)) continue;
    bag.add(
      'MD048',
      def,
      `link reference definition \`[${def.identifier}]\` is never used`,
      `Reference it with \`[text][${def.identifier}]\`, or delete the definition.`,
    );
  }
}

/* ---------------------------------------------------------------------------- footnotes */

/**
 * MD070 (reference with no definition), MD071 (definition never referenced),
 * MD072 (two definitions for one label).
 * @param {{ footnoteDefs: any[], footnoteRefs: any[] }} facts
 * @param {ReturnType<typeof createBag>} bag
 */
function checkFootnotes(facts, bag) {
  /** @type {Map<string, any>} first definition wins, the rest are MD072 */
  const defined = new Map();

  for (const def of facts.footnoteDefs) {
    const id = normalizeLabel(def.identifier ?? '');
    if (id === '') continue;
    const first = defined.get(id);
    if (first) {
      bag.add(
        'MD072',
        def,
        `duplicate footnote definition \`[^${def.identifier}]\` (first defined on line ${first.line ?? 1})`,
        'Give each footnote a unique label; only the first definition is rendered.',
      );
      continue;
    }
    defined.set(id, def);
  }

  /** @type {Set<string>} */
  const referenced = new Set();
  for (const ref of facts.footnoteRefs) {
    const id = normalizeLabel(ref.identifier ?? '');
    if (id === '') continue;
    referenced.add(id);
    if (defined.has(id)) continue;
    bag.add(
      'MD070',
      ref,
      `footnote reference \`[^${ref.identifier}]\` has no definition`,
      `Add \`[^${ref.identifier}]: your note\` on its own line.`,
    );
  }

  // Reported once per label, on the first definition -- extras are already MD072.
  for (const [id, def] of defined) {
    if (referenced.has(id)) continue;
    bag.add(
      'MD071',
      def,
      `footnote definition \`[^${def.identifier}]\` is never referenced`,
      `Add \`[^${def.identifier}]\` in the text, or remove the definition.`,
    );
  }
}

/* ------------------------------------------------------------------------------ tables */

/**
 * MD031 re-check on the assembled node. The lexer counts pipes on a line; the parser knows
 * how many cells that line actually produced (escaped pipes, trailing separators). Both may
 * fire -- `dedupe` keeps one.
 * @param {any[]} tables
 * @param {ReturnType<typeof createBag>} bag
 */
function checkTables(tables, bag) {
  for (const table of tables) {
    const header = Array.isArray(table.header) ? table.header : [];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    if (header.length === 0) continue; // a header-less table is MD030's problem

    for (const row of rows) {
      if (!Array.isArray(row) || row.length === header.length) continue;
      const anchor = row[0] && typeof row[0] === 'object' ? row[0] : table;
      bag.add(
        'MD031',
        { line: anchor.line ?? table.line, column: anchor.column ?? table.column },
        `table row has ${row.length} ${row.length === 1 ? 'cell' : 'cells'} but the header has ${header.length}`,
        'Add or remove `|`-separated cells so every row matches the header row.',
      );
    }
  }
}

/* ------------------------------------------------------------------------------ shared */

/**
 * CommonMark label matching: case-insensitive, whitespace-collapsed. Applied to footnote
 * labels too, so `[^Note]` and `[^note]` are never reported as an orphan pair.
 * @param {string} label
 * @returns {string}
 */
function normalizeLabel(label) {
  return String(label).trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase();
}

/**
 * Drop diagnostics that duplicate one another or one the scanners already reported.
 * @param {Diagnostic[]} list this pass's findings
 * @param {Diagnostic[]} existing diagnostics already held by the shared bag
 * @returns {Diagnostic[]}
 */
function dedupe(list, existing) {
  /** @type {Set<string>} */
  const seen = new Set();
  const remember = (d) => {
    seen.add(`${d.code}|${d.line}|${d.column}`);
    if (LINE_LEVEL_CODES.has(d.code)) seen.add(`${d.code}|${d.line}`);
  };
  for (const d of existing) remember(d);

  const out = [];
  for (const d of list) {
    if (seen.has(`${d.code}|${d.line}|${d.column}`)) continue;
    if (LINE_LEVEL_CODES.has(d.code) && seen.has(`${d.code}|${d.line}`)) continue;
    remember(d);
    out.push(d);
  }
  return out;
}
