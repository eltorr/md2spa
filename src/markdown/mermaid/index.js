/**
 * Mermaid diagrams, rendered to SVG at build time.
 *
 * This is the only door into the subsystem. It takes the body of a ```mermaid fence, decides
 * what kind of diagram it is, runs parse -> layout -> render, and hands back finished markup
 * plus diagnostics.
 *
 * Two properties are load-bearing:
 *
 *   1. **It never throws.** A diagram is user input arriving in the middle of a build; the
 *      worst it may do is come back as `svg: null` with a diagnostic, and the caller falls
 *      back to an ordinary code block. Every path below ends in a return, not a raise.
 *   2. **It is deterministic.** Marker ids come from the diagram's index on the page rather
 *      than from a counter with a life of its own, so the same document always emits the same
 *      bytes -- which is what lets two builds be diffed.
 *
 * Why any of this exists: bundling mermaid.js would put roughly a megabyte of JavaScript on
 * every page and break the project's defining property. Rendering here means diagrams work
 * with JavaScript disabled, inherit the reader's theme through CSS, and cost nothing at
 * runtime.
 *
 * @module markdown/mermaid
 */

import { createBag } from '../diagnostics.js';
import * as flowchartParser from './flowchart/parse.js';
import * as flowchartLayout from './flowchart/layout.js';
import * as sequenceParser from './sequence/parse.js';
import * as sequenceLayout from './sequence/layout.js';
import { renderFlowchartSvg } from './render/flowchart.js';
import { renderSequenceSvg } from './render/sequence.js';

/**
 * Ceilings past which a diagram is reported (`MD084`) instead of drawn. Layout is superlinear
 * in places, and a docs build is not the right place to discover that; past these sizes the
 * result would be unreadable long before it would be slow.
 */
export const LIMITS = Object.freeze({
  nodes: 300,
  edges: 600,
  participants: 60,
  messages: 400,
  lines: 5000,
});

/** Never absorb more than this many diagnostics from a single diagram. */
const MAX_DIAGNOSTICS = 200;

/**
 * @typedef {Object} MermaidResult
 * @property {string|null} svg the complete `<figure class="diagram">…</figure>`, or `null`
 *   when the diagram could not be drawn and the caller should emit a code block instead
 * @property {'flowchart'|'sequence'|null} kind the diagram type that was dispatched to
 * @property {import('../diagnostics.js').Diagnostic[]} diagnostics
 */

/**
 * Render one mermaid fence.
 *
 * @param {string} source the fence body, verbatim
 * @param {{ file?: string, line?: number, column?: number, config?: object, index?: number,
 *           idPrefix?: string }} [opts]
 *   `opts.line` is the 1-based source line of the fence's first content line and `opts.column`
 *   its indent, so diagnostics point at the real file position; both are handed to the
 *   parsers, which position their own findings. `opts.index` is the diagram's 1-based position
 *   in the document and becomes the `d<N>-` id namespace; pass `opts.idPrefix` to set it
 *   outright.
 * @returns {MermaidResult}
 */
export function renderMermaid(source, opts = {}) {
  // `opts` is explicitly null in enough real call sites that defaulting on `undefined` alone
  // would break the never-throws guarantee before the first useful line runs.
  const options = opts || {};
  const file = String(options.file ?? '<input>');
  const rules = options.config?.rules ?? {};
  const baseLine = int(options.line, 1);
  const bag = createBag(file, { rules });
  const text = String(source ?? '');
  const lines = text.split('\n');

  /**
   * Position one of *this* module's own findings, which are expressed in diagram-local
   * coordinates. Findings that come back from a parser are already in document coordinates
   * and are absorbed untouched.
   *
   * @param {number} line 1-based, relative to the fence body
   * @param {number} column
   * @returns {{ line: number, column: number }}
   */
  const locate = (line, column) => ({ line: baseLine + int(line, 1) - 1, column: int(column, 1) });

  if (lines.length > LIMITS.lines) {
    bag.add('MD084', locate(1, 1),
      `mermaid diagram is ${lines.length} lines, above the ${LIMITS.lines}-line limit`,
      'Split it into several smaller diagrams.');
    return { svg: null, kind: null, diagnostics: bag.list() };
  }

  const detected = detectKind(lines);
  if (detected.kind === null) {
    bag.add('MD080', locate(detected.line, detected.column),
      detected.token
        ? `mermaid diagram type \`${detected.token}\` is not supported`
        : 'mermaid block is empty',
      detected.token
        ? 'md2spa draws `flowchart`/`graph` and `sequenceDiagram`; anything else is left as a code block.'
        : 'Start the block with `flowchart TD` or `sequenceDiagram`.');
    return { svg: null, kind: null, diagnostics: bag.list() };
  }

  // The parsers strip their own comments and report `%%{init}%%` themselves, so they get the
  // source verbatim -- reporting MD083 here too would say it twice.
  const env = {
    bag,
    file,
    locate,
    source: text,
    parseOpts: { file, line: baseLine, column: int(options.column, 1), rules },
  };
  const ctx = { idPrefix: idPrefixOf(options) };

  try {
    const svg = detected.kind === 'flowchart' ? buildFlowchart(env, ctx) : buildSequence(env, ctx);
    return { svg, kind: detected.kind, diagnostics: bag.list() };
  } catch (error) {
    // Nothing below this point may escape into the build. A crash here is a defect in md2spa,
    // and the honest outcome is the author's own source, shown as a code block.
    bag.add('MD081', locate(1, 1),
      `mermaid diagram could not be rendered: ${messageOf(error)}`,
      'This is a defect in md2spa. The block was left as code so the page still builds.');
    return { svg: null, kind: detected.kind, diagnostics: bag.list() };
  }
}

/**
 * @param {{ bag: object, file: string, locate: Function, source: string, parseOpts: object }} env
 * @param {object} ctx
 * @returns {string|null}
 */
function buildFlowchart(env, ctx) {
  const parse = pick(flowchartParser, ['parseFlowchart', 'parse']);
  const layout = pick(flowchartLayout, ['layoutFlowchart', 'layout']);
  if (!parse) throw new Error('flowchart/parse.js exports no parseFlowchart()');
  if (!layout) throw new Error('flowchart/layout.js exports no layoutFlowchart()');

  const parsed = unwrap(parse(env.source, env.parseOpts), ['graph', 'flowchart', 'model']);
  absorb(env, parsed.diagnostics);
  const graph = parsed.value;

  const nodeCount = countOf(graph?.nodes);
  const edgeCount = countOf(graph?.edges);
  if (nodeCount > LIMITS.nodes) return tooBig(env, 'nodes', nodeCount, LIMITS.nodes);
  if (edgeCount > LIMITS.edges) return tooBig(env, 'edges', edgeCount, LIMITS.edges);
  if (nodeCount === 0) {
    return empty(env, 'flowchart declares no nodes',
      'Add at least one node, for example `A[Start] --> B[Done]`.');
  }

  const positioned = unwrap(layout(graph, env.parseOpts), ['layout', 'positioned']);
  absorb(env, positioned.diagnostics);
  if (!positioned.value) throw new Error('flowchart layout returned nothing');

  return renderFlowchartSvg(positioned.value, ctx);
}

/**
 * @param {{ bag: object, file: string, locate: Function, source: string, parseOpts: object }} env
 * @param {object} ctx
 * @returns {string|null}
 */
function buildSequence(env, ctx) {
  const parse = pick(sequenceParser, ['parseSequence', 'parseSequenceDiagram', 'parse']);
  const layout = pick(sequenceLayout, ['layoutSequence', 'layout']);
  if (!parse) throw new Error('sequence/parse.js exports no parseSequence()');
  if (!layout) throw new Error('sequence/layout.js exports no layoutSequence()');

  const parsed = unwrap(parse(env.source, env.parseOpts), ['sequence', 'model', 'diagram']);
  absorb(env, parsed.diagnostics);
  const model = parsed.value;

  const participantCount = countOf(model?.participants);
  const messageCount = countOf(model?.messages);
  if (participantCount > LIMITS.participants) {
    return tooBig(env, 'participants', participantCount, LIMITS.participants);
  }
  if (messageCount > LIMITS.messages) {
    return tooBig(env, 'messages', messageCount, LIMITS.messages);
  }
  if (participantCount === 0) {
    return empty(env, 'sequence diagram declares no participants',
      'Add at least one message, for example `Alice->>Bob: hello`.');
  }

  const positioned = unwrap(layout(model, env.parseOpts), ['layout', 'positioned']);
  absorb(env, positioned.diagnostics);
  if (!positioned.value) throw new Error('sequence layout returned nothing');

  return renderSequenceSvg(positioned.value, ctx);
}

/**
 * @param {object} env
 * @param {string} what plural noun
 * @param {number} count
 * @param {number} limit
 * @returns {null}
 */
function tooBig(env, what, count, limit) {
  // A parser that hit its own ceiling has already said so, at the line where it stopped
  // reading. That is the more useful position, so it wins.
  if (!has(env.bag, 'MD084')) {
    env.bag.add('MD084', env.locate(1, 1),
      `mermaid diagram has ${count} ${what}, above the ${limit}-${singular(what)} limit`,
      'Split it into several smaller diagrams.');
  }
  return null;
}

/**
 * @param {{ list: () => Array<{ code: string }> }} bag
 * @param {string} code
 * @returns {boolean}
 */
function has(bag, code) {
  return bag.list().some((d) => d.code === code);
}

/**
 * An empty diagram is only worth reporting when the parser has not already said something
 * sharper about the line that went wrong.
 *
 * `MD084` counts as sharper even though it is only a warning: a parser that stopped at a size
 * ceiling has necessarily produced no nodes, so claiming the author declared none would be
 * both untrue and -- because `MD081` is an error -- would turn a warning-level condition into
 * a failed build.
 *
 * @param {object} env
 * @param {string} message
 * @param {string} hint
 * @returns {null}
 */
function empty(env, message, hint) {
  if (env.bag.hasErrors() || has(env.bag, 'MD084')) return null;
  // Not a syntax error: the header parsed fine, there was simply nothing to draw. Reporting
  // this as MD081 made a placeholder fence -- `graph TD` with the body still to be written --
  // fail any `--strict` build. The outcome matches the unsupported-diagram case exactly (no
  // SVG, falls back to a code block), so it carries the same informational code.
  env.bag.add('MD080', env.locate(1, 1), `mermaid ${message}`, hint);
  return null;
}

/**
 * Dispatch on the first line with anything on it. Comments are skipped rather than stripped:
 * the parsers want the source verbatim, and all this needs is the diagram's first word.
 *
 * @param {string[]} lines
 * @returns {{ kind: 'flowchart'|'sequence'|null, line: number, column: number, token: string }}
 */
function detectKind(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('%%')) continue;
    const column = lines[i].length - lines[i].trimStart().length + 1;
    if (/^(?:graph|flowchart)\b/i.test(trimmed)) {
      return { kind: 'flowchart', line: i + 1, column, token: '' };
    }
    if (/^sequencediagram\b/i.test(trimmed)) {
      return { kind: 'sequence', line: i + 1, column, token: '' };
    }
    const token = (/^[A-Za-z][\w-]*/.exec(trimmed) || [trimmed.slice(0, 24)])[0];
    return { kind: null, line: i + 1, column, token };
  }
  return { kind: null, line: 1, column: 1, token: '' };
}

/**
 * Fold a sub-module's diagnostics into this document's bag.
 *
 * They arrive already positioned in the Markdown file (the parsers are given `opts.line`) and
 * with severities already resolved against the same `config.rules`, so they are passed through
 * rather than re-created -- re-mapping them here would shift every one of them a second time.
 *
 * @param {{ bag: object, file: string }} env
 * @param {unknown} diagnostics
 */
function absorb(env, diagnostics) {
  if (!Array.isArray(diagnostics)) return;
  const limit = Math.min(diagnostics.length, MAX_DIAGNOSTICS);
  /** @type {object[]} */
  const kept = [];
  for (let i = 0; i < limit; i += 1) {
    const d = diagnostics[i];
    if (!d || typeof d !== 'object' || typeof d.code !== 'string') continue;
    kept.push(d.file ? d : { ...d, file: env.file });
  }
  if (kept.length) env.bag.absorb(kept);
}

/**
 * Accept either a model or `{ model, diagnostics }` from a stage, so a stage with nothing to
 * report does not have to invent an empty wrapper.
 * @param {unknown} result
 * @param {string[]} keys candidate property names holding the model
 * @returns {{ value: object|null, diagnostics: unknown }}
 */
function unwrap(result, keys) {
  if (!result || typeof result !== 'object') return { value: null, diagnostics: [] };
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  for (const key of keys) {
    const candidate = /** @type {Record<string, unknown>} */ (result)[key];
    if (candidate && typeof candidate === 'object') {
      return { value: /** @type {object} */ (candidate), diagnostics };
    }
  }
  return { value: /** @type {object} */ (result), diagnostics };
}

/**
 * First function among `names` that the module actually exports.
 *
 * Parse and layout are separate modules with their own lifecycles. Resolving by name here
 * means a rename surfaces as one diagnostic on one diagram, rather than as a module-load
 * failure that takes down the whole build before a single page is written.
 *
 * @param {object} namespace
 * @param {string[]} names
 * @returns {Function|null}
 */
function pick(namespace, names) {
  for (const name of names) {
    const value = /** @type {Record<string, unknown>} */ (namespace)?.[name];
    if (typeof value === 'function') return /** @type {Function} */ (value);
  }
  return null;
}

/**
 * Size of a Map, Set, array or plain-object collection.
 * @param {unknown} collection
 * @returns {number}
 */
function countOf(collection) {
  if (!collection) return 0;
  if (Array.isArray(collection)) return collection.length;
  if (collection instanceof Map || collection instanceof Set) return collection.size;
  if (typeof collection === 'object') return Object.keys(collection).length;
  return 0;
}

/**
 * @param {{ index?: number, idPrefix?: string }} opts
 * @returns {string} an id namespace safe to interpolate into `url(#…)`
 */
function idPrefixOf(opts) {
  const explicit = String(opts.idPrefix ?? '').replace(/[^A-Za-z0-9_-]+/g, '');
  return explicit || `d${int(opts.index, 1)}`;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback;
}

/** @param {string} word @returns {string} */
function singular(word) {
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  const text = error && typeof error === 'object' && 'message' in error
    ? String(/** @type {Error} */ (error).message)
    : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}
