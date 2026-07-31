/**
 * Mermaid diagrams, build-time SVG -- SPEC-MERMAID.md §10.
 *
 * The headline requirement for this subsystem is not "a diagram appears" but "the diagram
 * is spaced and normalised properly". Nothing about that is visible from the emitted
 * string, so the layout invariants below are the only automated check on it: they are
 * written as reusable assertion helpers and every fixture is pushed through all of them,
 * table-driven, so that a missing invariant shows up as an obvious row of failures rather
 * than a quietly ugly picture.
 *
 * Three things the suite deliberately does:
 *
 *  1. **Loads the subsystem lazily.** The suite is written against the contract, not
 *     against whatever exists on disk, so a missing module fails the tests that need it
 *     instead of aborting the file.
 *  2. **Pins data shapes, not call conventions.** SPEC-MERMAID pins `renderMermaid` and the
 *     `FlowGraph`/`PositionedFlow` typedefs exactly; it does not name the parse/layout
 *     functions, so those are looked up by a short list of plausible names and their
 *     results normalised. What is asserted is the shape of the data.
 *  3. **Measures wall-clock.** §10 makes "must finish in < 2s" part of the contract, so the
 *     pathological cases are timed rather than merely run.
 *
 * Where SPEC-MERMAID is genuinely silent -- the `PositionedSequence` typedef, whether a
 * subgraph box's `x`/`y` is its top-left or its centre -- the assertion adapts or the
 * ambiguity is resolved in a comment. Everywhere else, a failure here means the
 * implementation deviates from the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, loadSrc, render, testConfig, timed } from './helpers/harness.js';

/** Wall-clock budget for the pathological cases, from SPEC-MERMAID §10. */
const BUDGET_MS = 2000;

// ---------------------------------------------------------------------------
// Lazy, fault-tolerant module loading
// ---------------------------------------------------------------------------

/** Every module SPEC-MERMAID §1 says the subsystem is made of. */
const MODULE_PATHS = {
  index: 'markdown/mermaid/index.js',
  text: 'markdown/mermaid/text.js',
  flowParse: 'markdown/mermaid/flowchart/parse.js',
  flowLayout: 'markdown/mermaid/flowchart/layout.js',
  seqParse: 'markdown/mermaid/sequence/parse.js',
  seqLayout: 'markdown/mermaid/sequence/layout.js',
};

/** @type {Promise<Record<string, {rel: string, mod: object|null, error: Error|null}>>|null} */
let subsystemPromise = null;

/**
 * Load the whole subsystem once, remembering per-module failures.
 * @returns {Promise<Record<string, {rel: string, mod: object|null, error: Error|null}>>}
 */
function subsystem() {
  if (!subsystemPromise) {
    subsystemPromise = (async () => {
      /** @type {Record<string, {rel: string, mod: object|null, error: Error|null}>} */
      const out = {};
      for (const [key, rel] of Object.entries(MODULE_PATHS)) {
        try {
          out[key] = { rel, mod: await loadSrc(rel), error: null };
        } catch (err) {
          out[key] = { rel, mod: null, error: /** @type {Error} */ (err) };
        }
      }
      return out;
    })();
  }
  return subsystemPromise;
}

/**
 * The first of `names` that the module exports as a function.
 *
 * SPEC-MERMAID names the *files* and the *data*, not the parse/layout entry points, so the
 * implementation is allowed to pick the name; the test is not allowed to guess silently.
 *
 * @param {{rel: string, mod: object|null, error: Error|null}} entry
 * @param {string[]} names
 * @returns {Function}
 */
function exported(entry, names) {
  if (!entry || entry.error) {
    throw new Error(`src/${entry ? entry.rel : '?'} could not be loaded: ${entry?.error?.message}`);
  }
  for (const name of names) {
    if (typeof entry.mod[name] === 'function') return entry.mod[name];
  }
  const have = Object.keys(entry.mod).join(', ') || 'nothing';
  throw new Error(`src/${entry.rel} exports none of [${names.join(', ')}]; it exports: ${have}`);
}

/**
 * An exported numeric constant, e.g. `LAYER_GAP`.
 * @param {{rel: string, mod: object|null, error: Error|null}} entry
 * @param {string} name
 * @returns {number}
 */
function constantOf(entry, name) {
  if (!entry || entry.error) {
    throw new Error(`src/${entry ? entry.rel : '?'} could not be loaded: ${entry?.error?.message}`);
  }
  const value = entry.mod[name];
  assert.equal(typeof value, 'number', `src/${entry.rel} must export the constant \`${name}\``);
  return /** @type {number} */ (value);
}

/**
 * The subsystem's public surface. Every property is a getter, so a test that only needs
 * the flowchart path is not failed by a missing sequence module.
 *
 * @returns {Promise<object>}
 */
async function api() {
  const s = await subsystem();
  return {
    get renderMermaid() { return exported(s.index, ['renderMermaid']); },
    get measureText() { return exported(s.text, ['measureText']); },
    get wrapText() { return exported(s.text, ['wrapText']); },
    get parseFlow() { return exported(s.flowParse, ['parseFlowchart', 'parseFlow', 'parse']); },
    get layoutFlow() { return exported(s.flowLayout, ['layoutFlowchart', 'layoutFlow', 'layout']); },
    get parseSequence() { return exported(s.seqParse, ['parseSequence', 'parse']); },
    get layoutSequence() { return exported(s.seqLayout, ['layoutSequence', 'layout']); },
    /** @param {string} name */
    flowConst(name) { return constantOf(s.flowLayout, name); },
    /** @param {string} name */
    seqConst(name) { return constantOf(s.seqLayout, name); },
  };
}

/**
 * A second argument that satisfies every plausible convention: it looks like an options
 * bag (`file`/`line`/`config`) *and* like a `diagnostics.js` bag (`add`/`list`/`absorb`),
 * so the call works whichever the implementation expects.
 *
 * @returns {object}
 */
function parseContext() {
  /** @type {object[]} */
  const items = [];
  return {
    file: 'test.md',
    line: 1,
    config: {},
    add(code, loc, message, hint) { items.push({ code, loc, message, hint }); },
    absorb(more) { for (const d of more || []) items.push(d); },
    list() { return items.slice(); },
    hasErrors() { return false; },
    get size() { return items.length; },
  };
}

// ---------------------------------------------------------------------------
// Result normalisers -- the data shapes SPEC-MERMAID §5a/§5b pin exactly
// ---------------------------------------------------------------------------

/**
 * Unwrap whatever `flowchart/parse.js` returns into the `FlowGraph` of §5a.
 * @param {any} result
 * @param {string} source for the failure message
 * @returns {{direction: string, nodes: Map<string, any>, edges: any[], subgraphs: any[]}}
 */
function asFlowGraph(result, source) {
  const graph = result && result.nodes ? result : result && (result.graph || result.flow);
  assert.ok(graph && graph.nodes, `flowchart parse returned no FlowGraph for:\n${source}`);
  assert.ok(
    graph.nodes instanceof Map,
    'SPEC-MERMAID §5a: FlowGraph.nodes must be an insertion-ordered Map',
  );
  assert.ok(Array.isArray(graph.edges), 'SPEC-MERMAID §5a: FlowGraph.edges must be an array');
  return graph;
}

/**
 * Unwrap whatever `flowchart/layout.js` returns into the `PositionedFlow` of §5b.
 * @param {any} result
 * @returns {{width: number, height: number, nodes: any[], edges: any[], subgraphs: any[]}}
 */
function asPositionedFlow(result) {
  const laid = result && Array.isArray(result.nodes)
    ? result
    : result && (result.layout || result.positioned);
  assert.ok(laid && Array.isArray(laid.nodes), 'flowchart layout returned no PositionedFlow');
  assert.ok(Array.isArray(laid.edges), 'PositionedFlow.edges must be an array');
  return laid;
}

/**
 * Unwrap whatever `sequence/parse.js` returns into its model.
 * @param {any} result
 * @returns {object}
 */
function asSequenceModel(result) {
  const model = result && (result.messages || result.participants || result.steps)
    ? result
    : result && (result.model || result.sequence);
  assert.ok(model && typeof model === 'object', 'sequence parse returned no model');
  return model;
}

/**
 * Unwrap whatever `sequence/layout.js` returns.
 * @param {any} result
 * @returns {object}
 */
function asPositionedSequence(result) {
  const laid = result && (Array.isArray(result.participants) || Array.isArray(result.lifelines))
    ? result
    : result && (result.layout || result.positioned);
  assert.ok(laid && typeof laid === 'object', 'sequence layout returned no PositionedSequence');
  return laid;
}

/**
 * Parse + lay out a flowchart.
 * @param {string} source
 * @returns {Promise<{graph: any, positioned: any}>}
 */
async function flowFixture(source) {
  const { parseFlow, layoutFlow } = await api();
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  const positioned = asPositionedFlow(layoutFlow(graph, parseContext()));
  return { graph, positioned };
}

/**
 * Parse + lay out a sequence diagram.
 * @param {string} source
 * @returns {Promise<{model: any, positioned: any}>}
 */
async function sequenceFixture(source) {
  const { parseSequence, layoutSequence } = await api();
  const model = asSequenceModel(parseSequence(source, parseContext()));
  const positioned = asPositionedSequence(layoutSequence(model, parseContext()));
  return { model, positioned };
}

// ---------------------------------------------------------------------------
// String / SVG utilities
// ---------------------------------------------------------------------------

/**
 * Wrap a diagram source in a fenced code block.
 * @param {string} source
 * @param {string} [lang]
 * @returns {string}
 */
function fence(source, lang = 'mermaid') {
  return `\`\`\`${lang}\n${source.replace(/\n?$/, '\n')}\`\`\`\n`;
}

/**
 * The `<svg>…</svg>` element of a rendered diagram.
 *
 * SPEC-MERMAID §2 returns `svg` while §9 has the *renderer* wrap it in `<figure>`, so the
 * entry point is allowed to return either; the element itself is what §7 pins.
 *
 * @param {string} markup
 * @returns {string}
 */
function svgElement(markup) {
  const start = markup.indexOf('<svg');
  const end = markup.lastIndexOf('</svg>');
  assert.ok(start >= 0 && end > start, `no <svg> element in output:\n${markup.slice(0, 400)}`);
  return markup.slice(start, end + '</svg>'.length);
}

/**
 * Attribute value from the first element matching `pattern`.
 * @param {string} markup
 * @param {string} name
 * @returns {string|null}
 */
function attrOf(markup, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(markup);
  return match ? match[1] : null;
}

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };

/**
 * Decode the entity set `util/html.js#escapeHtml` produces. `&amp;` is decoded last so
 * that `&amp;lt;` round-trips to the literal `&lt;` rather than to `<`.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    .replace(/&(lt|gt|quot|#39);/g, (m) => ENTITIES[m])
    .replace(/&amp;/g, '&');
}

/**
 * The visible text of every `<text>` carrying `cls`, in document order.
 * @param {string} svg
 * @param {string} cls
 * @returns {string[]}
 */
function svgTexts(svg, cls) {
  const out = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const classes = (attrOf(`<x${match[1]}>`, 'class') || '').split(/\s+/);
    if (!classes.includes(cls)) continue;
    out.push(decodeEntities(match[2].replace(/<[^>]*>/g, '')));
  }
  return out;
}

/**
 * Every `class="…"` token list in the markup, flattened.
 * @param {string} markup
 * @returns {string[]}
 */
function classTokens(markup) {
  return [...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
}

/**
 * Count non-overlapping matches.
 * @param {string} haystack
 * @param {RegExp} pattern must carry the `g` flag
 * @returns {number}
 */
function count(haystack, pattern) {
  return [...haystack.matchAll(pattern)].length;
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/**
 * @param {any} v
 * @returns {boolean}
 */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The axis-aligned box of a positioned node. §5b: `x`/`y` are the *centre*.
 * @param {{id: string, x: number, y: number, w: number, h: number}} node
 * @returns {{id: string, x0: number, y0: number, x1: number, y1: number}}
 */
function nodeRect(node) {
  return {
    id: node.id,
    x0: node.x - node.w / 2,
    y0: node.y - node.h / 2,
    x1: node.x + node.w / 2,
    y1: node.y + node.h / 2,
  };
}

/**
 * Validate that a `PositionedFlow` is numerically sane before any comparison runs.
 *
 * This guard is load-bearing: `NaN < 0` is `false`, so a layout that produced `NaN`
 * coordinates would silently *pass* every overlap and separation check below.
 *
 * @param {any} positioned
 * @param {string} [label]
 * @returns {any[]} the node list
 */
function checkedNodes(positioned, label = 'diagram') {
  assert.ok(Array.isArray(positioned?.nodes), `${label}: PositionedFlow.nodes must be an array`);
  for (const node of positioned.nodes) {
    for (const key of ['x', 'y', 'w', 'h']) {
      assert.ok(
        finite(node?.[key]),
        `${label}: node ${JSON.stringify(node?.id)} has a non-finite \`${key}\`: ${node?.[key]}`,
      );
    }
    assert.ok(node.w > 0 && node.h > 0, `${label}: node ${node.id} has a zero/negative size`);
  }
  return positioned.nodes;
}

/**
 * Do two boxes share positive area? Touching edges are not an overlap.
 * @param {{x0: number, y0: number, x1: number, y1: number}} a
 * @param {{x0: number, y0: number, x1: number, y1: number}} b
 * @param {number} [eps]
 * @returns {boolean}
 */
function boxesOverlap(a, b, eps = 0.5) {
  return a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.y0 < b.y1 - eps && b.y0 < a.y1 - eps;
}

/**
 * Is `inner` completely inside `outer`?
 * @param {{x0: number, y0: number, x1: number, y1: number}} inner
 * @param {{x0: number, y0: number, x1: number, y1: number}} outer
 * @param {number} [eps]
 * @returns {boolean}
 */
function boxContains(outer, inner, eps = 0.5) {
  return inner.x0 >= outer.x0 - eps && inner.x1 <= outer.x1 + eps
    && inner.y0 >= outer.y0 - eps && inner.y1 <= outer.y1 + eps;
}

/**
 * Signed distance from a point to an axis-aligned box, negative inside.
 * @param {number} dx offset from the centre
 * @param {number} dy
 * @param {number} hw half width
 * @param {number} hh half height
 * @returns {number}
 */
function rectSdf(dx, dy, hw, hh) {
  const qx = Math.abs(dx) - hw;
  const qy = Math.abs(dy) - hh;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/**
 * Signed distance to a rounded box, negative inside.
 * @param {number} dx
 * @param {number} dy
 * @param {number} hw
 * @param {number} hh
 * @param {number} r
 * @returns {number}
 */
function roundedRectSdf(dx, dy, hw, hh, r) {
  return rectSdf(dx, dy, Math.max(hw - r, 0), Math.max(hh - r, 0)) - r;
}

/**
 * Radial error for a shape whose boundary is the level set `f(p) = 1` of a function that
 * is positively homogeneous of degree 1 (rhombus, ellipse).
 *
 * `f(t·u) = t·f(u)`, so the boundary along the ray through `p` sits at `|p| / f(p)`; the
 * error is how far past (positive) or short of (negative) that the point falls.
 *
 * @param {number} dx
 * @param {number} dy
 * @param {(x: number, y: number) => number} f
 * @returns {number}
 */
function radialError(dx, dy, f) {
  const r = Math.hypot(dx, dy);
  const k = f(dx, dy);
  if (k <= 0) return -Infinity; // the point is the centre: as far inside as it gets
  return r - r / k;
}

/**
 * Which analytic model stands in for each shape when checking edge endpoints.
 *
 * `rect`/`subroutine` are exactly rectangular; `stadium`, `circle` and `diamond` have a
 * geometry fully determined by `w`/`h`, and §5b calls those out by name ("diamonds and
 * circles especially"). The remaining shapes have a slant/notch/ellipse depth that
 * SPEC-MERMAID never pins, so they are checked against a *band*: inside the bounding box
 * and outside the inscribed rhombus. That still catches every real failure -- an endpoint
 * at the node centre, an endpoint floating away from the node, an endpoint buried in the
 * body -- without inventing geometry the contract does not specify.
 */
const SHAPE_MODEL = {
  rect: 'box',
  subroutine: 'box',
  round: 'box-soft',
  stadium: 'stadium',
  circle: 'ellipse',
  diamond: 'rhombus',
  hexagon: 'band',
  parallelogram: 'band',
  'parallelogram-alt': 'band',
  cylinder: 'band',
  flag: 'band',
};

/** Extra slack per model, on top of the caller's tolerance. */
const SHAPE_SLACK = { box: 0, 'box-soft': 3, stadium: 1, ellipse: 1.5, rhombus: 1, band: 0 };

/**
 * How far a point is from a node's shape outline, or `null` for band-modelled shapes,
 * which report a boolean verdict instead.
 *
 * @param {{x: number, y: number, w: number, h: number, shape: string}} node
 * @param {{x: number, y: number}} point
 * @param {number} tolerance
 * @returns {{ok: boolean, detail: string}}
 */
function outlineVerdict(node, point, tolerance) {
  const model = SHAPE_MODEL[node.shape] || 'band';
  const tol = tolerance + SHAPE_SLACK[model];
  const dx = point.x - node.x;
  const dy = point.y - node.y;
  const hw = node.w / 2;
  const hh = node.h / 2;

  if (model === 'band') {
    const outer = rectSdf(dx, dy, hw, hh);
    const inner = radialError(dx, dy, (px, py) => Math.abs(px) / hw + Math.abs(py) / hh);
    const ok = outer <= tolerance && inner >= -tolerance;
    return {
      ok,
      detail: `shape ${node.shape}: ${outer > tolerance ? `${outer.toFixed(2)}px outside the box` : `${(-inner).toFixed(2)}px inside the inscribed rhombus`}`,
    };
  }

  let distance;
  if (model === 'box' || model === 'box-soft') distance = rectSdf(dx, dy, hw, hh);
  else if (model === 'stadium') distance = roundedRectSdf(dx, dy, hw, hh, Math.min(hw, hh));
  else if (model === 'ellipse') distance = radialError(dx, dy, (px, py) => Math.hypot(px / hw, py / hh));
  else distance = radialError(dx, dy, (px, py) => Math.abs(px) / hw + Math.abs(py) / hh);

  return {
    ok: Math.abs(distance) <= tol,
    detail: `shape ${node.shape}: ${distance.toFixed(2)}px from the outline (tolerance ${tol})`,
  };
}

/**
 * Do two segments cross at an interior point of both? Touching endpoints and collinear
 * overlap do not count, so edges that merely meet at a shared node are not crossings.
 *
 * @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2
 * @param {{x: number, y: number}} p3
 * @param {{x: number, y: number}} p4
 * @returns {boolean}
 */
function segmentsCross(p1, p2, p3, p4) {
  const side = (a, b, c) => {
    const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
  };
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// ---------------------------------------------------------------------------
// Layout invariants -- the "spaced properly" acceptance tests (SPEC-MERMAID §10)
// ---------------------------------------------------------------------------

/**
 * No two node boxes may share any area.
 *
 * @param {any} positioned a `PositionedFlow`
 * @param {string} [label] fixture name, for the failure message
 */
export function assertNoNodeOverlap(positioned, label = 'diagram') {
  const rects = checkedNodes(positioned, label).map(nodeRect);
  const violations = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (boxesOverlap(rects[i], rects[j])) {
        violations.push(
          `${rects[i].id} [${rects[i].x0},${rects[i].y0}..${rects[i].x1},${rects[i].y1}] `
          + `overlaps ${rects[j].id} [${rects[j].x0},${rects[j].y0}..${rects[j].x1},${rects[j].y1}]`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], `${label}: node boxes overlap`);
}

/**
 * Every subgraph in the `FlowGraph` tree, flattened, with the ids of *all* its descendant
 * nodes and its nesting depth.
 *
 * @param {any} graph a `FlowGraph`
 * @returns {Array<{id: string, title: string, nodeIds: string[], depth: number}>}
 */
function flattenSubgraphs(graph) {
  const out = [];
  const visit = (sub, depth) => {
    const own = [...(sub.nodeIds || [])];
    const kids = sub.children || [];
    for (const child of kids) own.push(...visit(child, depth + 1));
    out.push({ id: sub.id, title: sub.title, nodeIds: own, depth });
    return own;
  };
  for (const sub of graph?.subgraphs || []) visit(sub, 0);
  return out;
}

/**
 * Resolve a positioned subgraph box into a rectangle.
 *
 * SPEC-MERMAID §5b gives `{title,x,y,w,h,depth}` without saying whether `x`/`y` is the
 * top-left (as an SVG `<rect>` would want) or the centre (as it explicitly is for nodes).
 * Rather than guess, both readings are tried and the one under which every subgraph
 * actually contains its members is used; top-left wins ties. The *containment* invariant
 * is what matters and it is asserted either way.
 *
 * @param {any} positioned
 * @param {any} [graph]
 * @returns {{rects: Array<any>, convention: 'top-left'|'centre'}}
 */
function subgraphRects(positioned, graph = null) {
  const boxes = positioned?.subgraphs || [];
  const build = (centred) => boxes.map((b) => ({
    ...b,
    x0: centred ? b.x - b.w / 2 : b.x,
    y0: centred ? b.y - b.h / 2 : b.y,
    x1: centred ? b.x + b.w / 2 : b.x + b.w,
    y1: centred ? b.y + b.h / 2 : b.y + b.h,
  }));
  const topLeft = build(false);
  if (!graph || boxes.length === 0) return { rects: topLeft, convention: 'top-left' };
  const centre = build(true);
  return membershipViolations(positioned, graph, topLeft).length === 0
    ? { rects: topLeft, convention: 'top-left' }
    : membershipViolations(positioned, graph, centre).length === 0
      ? { rects: centre, convention: 'centre' }
      : { rects: topLeft, convention: 'top-left' };
}

/**
 * Members that fall outside the box they belong to.
 * @param {any} positioned
 * @param {any} graph
 * @param {Array<any>} rects
 * @returns {string[]}
 */
function membershipViolations(positioned, graph, rects) {
  const byId = new Map(positioned.nodes.map((n) => [n.id, nodeRect(n)]));
  const violations = [];
  for (const sub of flattenSubgraphs(graph)) {
    const box = rects.find((r) => r.title === sub.title || r.id === sub.id || r.title === sub.id);
    if (!box) {
      violations.push(`subgraph ${JSON.stringify(sub.title ?? sub.id)} has no positioned box`);
      continue;
    }
    for (const id of sub.nodeIds) {
      const rect = byId.get(id);
      if (!rect) continue; // the node may have been dropped by a limit; covered elsewhere
      if (!boxContains(box, rect)) {
        violations.push(
          `node ${id} [${rect.x0},${rect.y0}..${rect.x1},${rect.y1}] is not inside subgraph `
          + `${JSON.stringify(sub.title)} [${box.x0},${box.y0}..${box.x1},${box.y1}]`,
        );
      }
    }
  }
  return violations;
}

/**
 * Every node lies inside the subgraph box it belongs to, no node straddles a box border,
 * and nested boxes nest visually.
 *
 * `graph` is optional: without it the membership check is skipped and only the geometric
 * invariants (no straddling, proper nesting) are enforced.
 *
 * @param {any} positioned a `PositionedFlow`
 * @param {any} [graph] the `FlowGraph` it came from, for membership
 * @param {string} [label]
 */
export function assertNodesInsideSubgraphs(positioned, graph = null, label = 'diagram') {
  const nodes = checkedNodes(positioned, label);
  const boxes = positioned?.subgraphs || [];
  for (const box of boxes) {
    for (const key of ['x', 'y', 'w', 'h']) {
      assert.ok(finite(box?.[key]), `${label}: subgraph box has a non-finite \`${key}\``);
    }
    assert.ok(box.w > 0 && box.h > 0, `${label}: subgraph box has a zero/negative size`);
  }
  const { rects } = subgraphRects(positioned, graph);
  const violations = graph ? membershipViolations(positioned, graph, rects) : [];

  // A node may be wholly inside a box or wholly outside it, never half in: a box that
  // clips one of its neighbours' nodes is a drawing that lies about membership.
  for (const rect of nodes.map(nodeRect)) {
    for (const box of rects) {
      if (boxesOverlap(box, rect) && !boxContains(box, rect)) {
        violations.push(
          `node ${rect.id} straddles the border of subgraph ${JSON.stringify(box.title)}`,
        );
      }
    }
  }

  // Nesting: a deeper box is either disjoint from a shallower one or wholly inside it,
  // and boxes at the same depth never overlap.
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (!boxesOverlap(a, b)) continue;
      const outer = (a.depth ?? 0) <= (b.depth ?? 0) ? a : b;
      const inner = outer === a ? b : a;
      if ((a.depth ?? 0) === (b.depth ?? 0)) {
        violations.push(
          `subgraphs ${JSON.stringify(a.title)} and ${JSON.stringify(b.title)} are both at `
          + `depth ${a.depth ?? 0} but their boxes overlap`,
        );
      } else if (!boxContains(outer, inner)) {
        violations.push(
          `subgraph ${JSON.stringify(inner.title)} (depth ${inner.depth}) overlaps but does not `
          + `nest inside ${JSON.stringify(outer.title)} (depth ${outer.depth})`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], `${label}: subgraph containment`);
}

/**
 * Every edge's first point lies on the source node's shape outline and its last point on
 * the target's, within `tolerance` px.
 *
 * This is the assertion behind "arrowheads touch the border cleanly" in §5b step 8: an
 * endpoint left at the node centre, floating in open space, or clipped against the bounding
 * box instead of the real outline all fail here.
 *
 * @param {any} positioned a `PositionedFlow`
 * @param {number} [tolerance]
 * @param {string} [label]
 */
export function assertEdgeEndpointsOnOutline(positioned, tolerance = 1, label = 'diagram') {
  const nodes = checkedNodes(positioned, label);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const violations = [];

  assert.ok(Array.isArray(positioned.edges), `${label}: PositionedFlow.edges must be an array`);
  for (const edge of positioned.edges) {
    const points = edge?.points;
    assert.ok(
      Array.isArray(points) && points.length >= 2,
      `${label}: edge ${edge?.from}->${edge?.to} needs at least two points, got `
      + `${Array.isArray(points) ? points.length : typeof points}`,
    );
    for (const p of points) {
      assert.ok(
        finite(p?.x) && finite(p?.y),
        `${label}: edge ${edge.from}->${edge.to} has a non-finite point ${JSON.stringify(p)}`,
      );
    }

    for (const [id, point, end] of [
      [edge.from, points[0], 'start'],
      [edge.to, points[points.length - 1], 'end'],
    ]) {
      const node = byId.get(id);
      assert.ok(node, `${label}: edge endpoint ${JSON.stringify(id)} is not a positioned node`);
      const verdict = outlineVerdict(node, point, tolerance);
      if (!verdict.ok) {
        violations.push(
          `edge ${edge.from}->${edge.to} ${end} at (${point.x.toFixed(1)},${point.y.toFixed(1)}) `
          + `does not touch ${id}'s outline -- ${verdict.detail}`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], `${label}: edge endpoints off the shape outline`);
}

/**
 * Nodes are separated by at least `layerGap` along the layer axis and `nodeGap` across it.
 *
 * The check is expressed without needing to know which layer a node landed in, which the
 * `PositionedFlow` typedef does not record: two boxes whose projections overlap on one axis
 * are, by construction, stacked along the other, and that is the axis the gap applies to.
 *
 * @param {any} positioned a `PositionedFlow`
 * @param {number} layerGap `LAYER_GAP`
 * @param {number} nodeGap `NODE_GAP`
 * @param {'TD'|'TB'|'BT'|'LR'|'RL'} [direction] the layer axis; vertical unless LR/RL
 * @param {string} [label]
 */
export function assertMinimumSeparation(positioned, layerGap, nodeGap, direction = 'TD', label = 'diagram') {
  const rects = checkedNodes(positioned, label).map(nodeRect);
  const verticalLayers = direction !== 'LR' && direction !== 'RL';
  const acrossX = verticalLayers ? nodeGap : layerGap;
  const acrossY = verticalLayers ? layerGap : nodeGap;
  const violations = [];

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const gapX = Math.max(b.x0 - a.x1, a.x0 - b.x1);
      const gapY = Math.max(b.y0 - a.y1, a.y0 - b.y1);
      // Columns overlap => the pair is stacked vertically, so the vertical gap applies.
      if (gapX < 0 && gapY < acrossY - 0.5) {
        violations.push(
          `${a.id} and ${b.id} share a column but are only ${gapY.toFixed(1)}px apart `
          + `vertically (minimum ${acrossY})`,
        );
      }
      // Rows overlap => the pair is side by side, so the horizontal gap applies.
      if (gapY < 0 && gapX < acrossX - 0.5) {
        violations.push(
          `${a.id} and ${b.id} share a row but are only ${gapX.toFixed(1)}px apart `
          + `horizontally (minimum ${acrossX})`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], `${label}: minimum separation`);
}

/**
 * How many pairs of edges cross.
 *
 * Edges that share an endpoint node are not counted: they necessarily meet at that node,
 * and a layered drawing is judged on crossings between independent edges.
 *
 * @param {any} positioned a `PositionedFlow`
 * @returns {number}
 */
export function countEdgeCrossings(positioned) {
  const edges = (positioned?.edges || []).filter((e) => Array.isArray(e.points) && e.points.length >= 2);
  let crossings = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i];
      const b = edges[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      let crossed = false;
      for (let m = 0; m + 1 < a.points.length && !crossed; m += 1) {
        for (let n = 0; n + 1 < b.points.length && !crossed; n += 1) {
          if (segmentsCross(a.points[m], a.points[m + 1], b.points[n], b.points[n + 1])) crossed = true;
        }
      }
      if (crossed) crossings += 1;
    }
  }
  return crossings;
}

/**
 * Everything the layout drew fits inside the content box it reported.
 *
 * The SVG's `viewBox` is `0 0 W H`, so anything outside is clipped away in the browser.
 *
 * @param {any} positioned a `PositionedFlow`
 * @param {string} [label]
 */
export function assertContentBounds(positioned, label = 'diagram') {
  const nodes = checkedNodes(positioned, label);
  assert.ok(finite(positioned.width) && positioned.width > 0, `${label}: width must be positive`);
  assert.ok(finite(positioned.height) && positioned.height > 0, `${label}: height must be positive`);
  const violations = [];
  const check = (what, x0, y0, x1, y1, eps) => {
    if (x0 < -eps || y0 < -eps || x1 > positioned.width + eps || y1 > positioned.height + eps) {
      violations.push(
        `${what} [${x0.toFixed(1)},${y0.toFixed(1)}..${x1.toFixed(1)},${y1.toFixed(1)}] escapes `
        + `the ${positioned.width}x${positioned.height} content box`,
      );
    }
  };
  for (const rect of nodes.map(nodeRect)) check(`node ${rect.id}`, rect.x0, rect.y0, rect.x1, rect.y1, 1);
  for (const box of subgraphRects(positioned).rects) {
    check(`subgraph ${JSON.stringify(box.title)}`, box.x0, box.y0, box.x1, box.y1, 1);
  }
  for (const edge of positioned.edges || []) {
    for (const p of edge.points || []) check(`edge ${edge.from}->${edge.to}`, p.x, p.y, p.x, p.y, 2);
  }
  assert.deepEqual(violations, [], `${label}: content bounds`);
}

// ---------------------------------------------------------------------------
// Sequence-diagram invariants
// ---------------------------------------------------------------------------

/**
 * SPEC-MERMAID §6b describes the sequence layout's *behaviour* but never gives a
 * `PositionedSequence` typedef, so this suite fixes one. The shape asserted is:
 *
 *   { width, height,
 *     participants: [{ id, label, x, y, w, h }]     // x is the LIFELINE CENTRE
 *     messages:     [{ from, to, y, label, kind, self?, labelBox? }]
 *     activations:  [{ participant, y0, y1, depth, x?, w? }] }
 *
 * A handful of aliases are accepted (`lifelines`, `cx`, `top`/`bottom`, `of`) so a
 * reasonable implementation is not failed on a naming difference, but `participants[].x`
 * being the lifeline centre is load-bearing: every horizontal check below depends on it.
 *
 * @param {any} positioned
 * @returns {Array<{id: string, x: number, w: number, raw: any}>}
 */
function seqParticipants(positioned) {
  const list = positioned?.participants || positioned?.lifelines || positioned?.actors;
  assert.ok(
    Array.isArray(list) && list.length > 0,
    'PositionedSequence must expose a non-empty `participants` array',
  );
  return list.map((p, i) => {
    const x = p.cx ?? p.lifelineX ?? p.x;
    assert.ok(finite(x), `participant ${i} has no finite lifeline x (${JSON.stringify(p)})`);
    return { id: String(p.id ?? p.name ?? i), x, w: finite(p.w) ? p.w : 0, raw: p };
  });
}

/**
 * @param {any} positioned
 * @returns {any[]}
 */
function seqMessages(positioned) {
  const list = positioned?.messages || positioned?.arrows;
  assert.ok(Array.isArray(list), 'PositionedSequence must expose a `messages` array');
  return list;
}

/**
 * @param {any} positioned
 * @returns {Array<{participant: string, y0: number, y1: number, depth: number, x: number|null, w: number|null}>}
 */
function seqActivations(positioned) {
  const list = positioned?.activations || positioned?.bars || [];
  return list.map((a) => ({
    participant: String(a.participant ?? a.of ?? a.actor ?? a.id ?? ''),
    y0: a.y0 ?? a.top ?? a.y ?? a.yStart,
    y1: a.y1 ?? a.bottom ?? a.yEnd ?? (finite(a.y) && finite(a.h) ? a.y + a.h : undefined),
    depth: a.depth ?? a.level ?? a.nest ?? 0,
    x: finite(a.x) ? a.x : null,
    w: finite(a.w) ? a.w : null,
  }));
}

/**
 * The horizontal span a message label occupies.
 *
 * When the layout publishes label geometry it is used verbatim; otherwise the label is
 * measured with `measureText` and centred on the message, which under-estimates rather
 * than over-estimates (the layout may use a larger font), so the fallback never invents a
 * failure.
 *
 * @param {any} message
 * @param {number} fromX
 * @param {number} toX
 * @param {(text: string, opts?: object) => {width: number}} measure
 * @returns {{x0: number, x1: number, text: string}|null}
 */
function labelSpan(message, fromX, toX, measure) {
  // A wrapped label is an array of lines; its width is the widest line, not their sum.
  const lines = Array.isArray(message.label)
    ? message.label.map(String)
    : String(message.label ?? '').split('\n');
  const text = lines.join(' ');
  if (!text.trim()) return null;

  const box = message.labelBox || message.label_box;
  if (box && finite(box.x) && finite(box.w)) {
    return { x0: box.x, x1: box.x + box.w, text, measured: false };
  }
  if (finite(message.labelX) && finite(message.labelW)) {
    // labelX is a centre when the label is drawn with text-anchor="middle".
    return {
      x0: message.labelX - message.labelW / 2,
      x1: message.labelX + message.labelW / 2,
      text,
      measured: false,
    };
  }

  const width = Math.max(...lines.map((line) => measure(line).width));
  if (Math.abs(fromX - toX) < 0.5) {
    return { x0: fromX, x1: fromX + width, text, measured: true }; // self-message, drawn right
  }
  const mid = finite(message.labelPos?.x) ? message.labelPos.x : (fromX + toX) / 2;
  return { x0: mid - width / 2, x1: mid + width / 2, text, measured: true };
}

/**
 * A message label may never reach a lifeline outside its own span.
 *
 * This is the assertion behind §6b's "messages must never overlap their neighbours'
 * lifelines": between two adjacent participants there is no intervening lifeline, so a
 * label that touches one has bled past its neighbour and the column was not widened.
 * Lifelines *between* the endpoints of a long-range message are excluded -- crossing those
 * is unavoidable and correct.
 *
 * @param {any} sequencePositioned a `PositionedSequence`
 * @param {(text: string, opts?: object) => {width: number}} [measure] `measureText`
 * @param {string} [label]
 */
export function assertNoLabelLifelineOverlap(sequencePositioned, measure = null, label = 'sequence') {
  const participants = seqParticipants(sequencePositioned);
  const byId = new Map(participants.map((p) => [p.id, p]));
  const violations = [];
  let checked = 0;

  for (const message of seqMessages(sequencePositioned)) {
    const from = byId.get(String(message.from ?? message.source));
    const to = byId.get(String(message.to ?? message.target));
    if (!from || !to) {
      violations.push(`message ${message.from}->${message.to} names an unknown participant`);
      continue;
    }
    const span = labelSpan(message, from.x, to.x, measure || ((t) => ({ width: t.length * 7 })));
    if (!span) continue;
    checked += 1;
    const lo = Math.min(from.x, to.x);
    const hi = Math.max(from.x, to.x);
    for (const other of participants) {
      if (other.x >= lo - 0.5 && other.x <= hi + 0.5) continue; // inside the message's own span
      if (other.x > span.x0 + 0.5 && other.x < span.x1 - 0.5) {
        violations.push(
          `label ${JSON.stringify(span.text)} on ${from.id}->${to.id} spans `
          + `${span.x0.toFixed(1)}..${span.x1.toFixed(1)} and runs through ${other.id}'s `
          + `lifeline at x=${other.x.toFixed(1)}`,
        );
      }
    }

    // §6b widens a column when the label between two neighbours would not fit, so a label
    // that spills past its own endpoints has not been given the room it asked for -- and
    // between adjacent participants there is no lifeline there to catch it above.
    // A measured span is approximate (the layout may size text differently), so the
    // fallback path allows a little slack; published geometry is held to the pixel.
    if (from.id !== to.id) {
      const slack = span.measured ? (span.x1 - span.x0) * 0.1 + 2 : 1;
      if (span.x0 < lo - slack || span.x1 > hi + slack) {
        violations.push(
          `label ${JSON.stringify(span.text)} on ${from.id}->${to.id} spans `
          + `${span.x0.toFixed(1)}..${span.x1.toFixed(1)} but its column only runs `
          + `${lo.toFixed(1)}..${hi.toFixed(1)} -- the column was not widened to fit it`,
        );
      }
    }
  }
  assert.ok(checked > 0, `${label}: no labelled messages were checked -- the fixture is vacuous`);
  assert.deepEqual(violations, [], `${label}: message labels cross a neighbour's lifeline`);
}

/**
 * Activation bars on one participant nest: they are disjoint or strictly contained, never
 * partially overlapping, and an inner bar is offset from its parent (§6b: 4px each).
 *
 * @param {any} sequencePositioned a `PositionedSequence`
 * @param {string} [label]
 */
export function assertActivationsNest(sequencePositioned, label = 'sequence') {
  const bars = seqActivations(sequencePositioned);
  const violations = [];
  for (const bar of bars) {
    assert.ok(
      finite(bar.y0) && finite(bar.y1),
      `${label}: activation on ${bar.participant} has no finite vertical extent`,
    );
    if (bar.y1 <= bar.y0) violations.push(`activation on ${bar.participant} has zero/negative height`);
  }
  for (let i = 0; i < bars.length; i += 1) {
    for (let j = i + 1; j < bars.length; j += 1) {
      const a = bars[i];
      const b = bars[j];
      if (a.participant !== b.participant) continue;
      const disjoint = a.y1 <= b.y0 + 0.5 || b.y1 <= a.y0 + 0.5;
      const aInB = a.y0 >= b.y0 - 0.5 && a.y1 <= b.y1 + 0.5;
      const bInA = b.y0 >= a.y0 - 0.5 && b.y1 <= a.y1 + 0.5;
      if (!disjoint && !aInB && !bInA) {
        violations.push(
          `activations on ${a.participant} partially overlap: `
          + `[${a.y0},${a.y1}] vs [${b.y0},${b.y1}]`,
        );
        continue;
      }
      if (disjoint) continue;
      const inner = aInB ? a : b;
      const outer = aInB ? b : a;
      if (inner.depth <= outer.depth) {
        violations.push(
          `nested activation on ${inner.participant} has depth ${inner.depth}, `
          + `not deeper than its enclosing bar (${outer.depth})`,
        );
      }
      if (inner.x !== null && outer.x !== null && Math.abs(inner.x - outer.x) < 3.5) {
        violations.push(
          `nested activation on ${inner.participant} is only `
          + `${Math.abs(inner.x - outer.x).toFixed(1)}px offset from its parent (expected ~4px)`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], `${label}: activation bars do not nest`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FlowFixture
 * @property {string} name
 * @property {string} source
 * @property {'TD'|'TB'|'BT'|'LR'|'RL'} direction
 * @property {number} [crossings] expected edge crossings, when SPEC-MERMAID pins them
 * @property {boolean} [subgraphs] whether the fixture exercises subgraph containment
 */

/** @type {FlowFixture[]} */
const FLOW_FIXTURES = [
  {
    name: 'chain',
    direction: 'TD',
    source: 'graph TD\n  A[Start] --> B[Middle] --> C[End]\n',
  },
  {
    // §10: "a 3-layer diamond graph produces 0 edge crossings".
    name: 'diamond',
    direction: 'TD',
    crossings: 0,
    source: 'graph TD\n  A[Request] --> B[Validate]\n  A --> C[Cache]\n  B --> D[Respond]\n  C --> D\n',
  },
  {
    name: 'every shape',
    direction: 'TD',
    source: [
      'graph TD',
      '  R[Rect] --> N(Round)',
      '  N --> S([Stadium])',
      '  S --> U[[Subroutine]]',
      '  U --> Y[(Cylinder)]',
      '  Y --> O((Circle))',
      '  O --> D{Diamond}',
      '  D --> H{{Hexagon}}',
      '  H --> P[/Parallelogram/]',
      '  P --> Q[\\Alt\\]',
      '  Q --> F>Flag]',
      '  F --> Z',
      '',
    ].join('\n'),
  },
  {
    name: 'every edge kind',
    direction: 'LR',
    source: 'graph LR\n  A --> B\n  B --- C\n  C -.-> D\n  D ==> E\n  E --x F\n  F --o G\n',
  },
  {
    name: 'edge labels, both forms',
    direction: 'TD',
    source: 'graph TD\n  A{Ready?} -->|yes| B[Ship]\n  A -- no --> C[Wait]\n  B --> D[Done]\n  C --> D\n',
  },
  {
    name: 'multi-target chains',
    direction: 'TD',
    source: 'graph TD\n  A --> B & C\n  B & C --> D\n',
  },
  {
    name: 'nested subgraphs',
    direction: 'TD',
    subgraphs: true,
    source: [
      'graph TD',
      '  A[Ingress] --> B[Router]',
      '  subgraph Cluster',
      '    subgraph Pods',
      '      B --> C[Pod A]',
      '      B --> E[Pod B]',
      '    end',
      '    C --> D[Store]',
      '    E --> D',
      '  end',
      '  D --> F[Egress]',
      '',
    ].join('\n'),
  },
  {
    name: 'subgraph with an inner direction',
    direction: 'TD',
    subgraphs: true,
    source: [
      'graph TD',
      '  A --> B',
      '  subgraph Side',
      '    direction LR',
      '    B --> C',
      '    C --> D',
      '  end',
      '  D --> E',
      '',
    ].join('\n'),
  },
  {
    name: 'classDef and :::',
    direction: 'TD',
    source: [
      'graph TD',
      '  classDef danger fill:#f00,stroke:#900',
      '  A[Boom]:::danger --> B[Safe]',
      '  B --> C[Also]',
      '  class C danger',
      '',
    ].join('\n'),
  },
  {
    name: 'cycle',
    direction: 'TD',
    source: 'graph TD\n  A --> B\n  B --> C\n  C --> A\n',
  },
  {
    name: 'edge spanning three layers',
    direction: 'TD',
    source: 'graph TD\n  A --> B --> C --> D\n  A --> D\n',
  },
  {
    name: 'wide fan-out',
    direction: 'TD',
    source: [
      'graph TD',
      '  Root --> C1[One]',
      '  Root --> C2[Two]',
      '  Root --> C3[Three]',
      '  Root --> C4[Four]',
      '  Root --> C5[Five]',
      '  Root --> C6[Six]',
      '',
    ].join('\n'),
  },
  {
    name: 'wrapped and explicit line breaks',
    direction: 'TD',
    source: [
      'graph TD',
      '  A["First line<br/>Second line"] --> B["A deliberately long label that has to wrap onto several lines"]',
      '  B --> C',
      '',
    ].join('\n'),
  },
  { name: 'direction LR', direction: 'LR', crossings: 0, source: 'graph LR\n  A --> B\n  A --> C\n  B --> D\n  C --> D\n' },
  { name: 'direction RL', direction: 'RL', crossings: 0, source: 'graph RL\n  A --> B\n  A --> C\n  B --> D\n  C --> D\n' },
  { name: 'direction BT', direction: 'BT', crossings: 0, source: 'graph BT\n  A --> B\n  A --> C\n  B --> D\n  C --> D\n' },
  {
    name: 'flowchart synonym with comments',
    direction: 'TD',
    source: 'flowchart TD\n  %% a comment line\n  A[One] --> B[Two]\n  %% another\n  B --> C[Three]\n',
  },
];

/**
 * @typedef {Object} SequenceFixture
 * @property {string} name
 * @property {string} source
 */

/** @type {SequenceFixture[]} */
const SEQUENCE_FIXTURES = [
  {
    name: 'every arrow form',
    source: [
      'sequenceDiagram',
      '  participant A as Client',
      '  participant B as Server',
      '  A->>B: solid arrow',
      '  B-->>A: dashed arrow',
      '  A->B: open arrow',
      '  B--)A: async dashed',
      '  A-)B: async open',
      '  B-xA: cross',
      '',
    ].join('\n'),
  },
  {
    name: 'notes in all placements',
    source: [
      'sequenceDiagram',
      '  participant A',
      '  participant B',
      '  Note left of A: on the left',
      '  A->>B: request',
      '  Note right of B: on the right',
      '  Note over A,B: spanning both',
      '  B-->>A: response',
      '',
    ].join('\n'),
  },
  {
    name: 'blocks: loop, alt/else, opt, par/and',
    source: [
      'sequenceDiagram',
      '  participant A',
      '  participant B',
      '  loop every minute',
      '    A->>B: poll',
      '  end',
      '  alt cache hit',
      '    B-->>A: cached',
      '  else cache miss',
      '    B-->>A: computed',
      '  end',
      '  opt debugging',
      '    A->>B: trace',
      '  end',
      '  par fan out',
      '    A->>B: left',
      '  and also',
      '    A->>B: right',
      '  end',
      '',
    ].join('\n'),
  },
  {
    name: 'activations, explicit and implicit',
    source: [
      'sequenceDiagram',
      '  participant A',
      '  participant B',
      '  activate A',
      '  A->>+B: outer',
      '  B->>+B: inner',
      '  B-->>-B: inner done',
      '  B-->>-A: outer done',
      '  deactivate A',
      '',
    ].join('\n'),
  },
  {
    name: 'self-messages and long-range messages',
    source: [
      'sequenceDiagram',
      '  participant A',
      '  participant B',
      '  participant C',
      '  A->>A: a fairly long self message label',
      '  A->>C: skips over B entirely',
      '  C-->>A: and back again',
      '',
    ].join('\n'),
  },
  {
    name: 'autonumber with auto-created participants',
    source: 'sequenceDiagram\n  autonumber\n  A->>B: first\n  B->>C: second\n  C-->>A: third\n',
  },
  {
    name: 'actors and long labels',
    source: [
      'sequenceDiagram',
      '  actor U as A Person With A Long Name',
      '  participant S as Service',
      '  U->>S: an unusually wordy message label goes here',
      '  S-->>U: short',
      '',
    ].join('\n'),
  },
];

// ---------------------------------------------------------------------------
// Spacing constants -- SPEC-MERMAID §5b / §6b
// ---------------------------------------------------------------------------

test('flowchart layout exports the documented spacing constants', async () => {
  const { flowConst } = await api();
  const expected = {
    LAYER_GAP: 56, NODE_GAP: 32, NODE_PAD_X: 16, NODE_PAD_Y: 12,
    MIN_W: 48, MIN_H: 36, SUB_PAD: 20, EDGE_LABEL_PAD: 6, CORNER: 6,
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(flowConst(name), value, `${name} must be ${value}`);
  }
});

test('sequence layout exports the documented spacing constants', async () => {
  const { seqConst } = await api();
  const expected = {
    PARTICIPANT_GAP: 48, MESSAGE_GAP: 40, ACTIVATION_W: 10,
    BLOCK_PAD: 8, REPEAT_HEADER_AFTER: 520,
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(seqConst(name), value, `${name} must be ${value}`);
  }
});

// ---------------------------------------------------------------------------
// Text metrics -- SPEC-MERMAID §4
// ---------------------------------------------------------------------------

test('measureText returns positive, finite px dimensions', async () => {
  const { measureText } = await api();
  const m = measureText('Hello', { size: 14 });
  assert.ok(finite(m.width) && m.width > 0, `width was ${m.width}`);
  assert.ok(finite(m.height) && m.height > 0, `height was ${m.height}`);
  // An empty string still has a line height but no meaningful advance.
  const empty = measureText('', { size: 14 });
  assert.ok(empty.width >= 0 && empty.width < m.width);
  assert.ok(empty.height > 0);
});

test('measureText line height is size * 1.35 (plus the documented pad)', async () => {
  const { measureText } = await api();
  for (const size of [12, 14, 18]) {
    const { height } = measureText('Ag', { size });
    assert.ok(
      height >= size * 1.35 - 0.01 && height <= size * 1.35 + 8,
      `height at size ${size} was ${height}, expected ~${(size * 1.35).toFixed(2)}`,
    );
  }
});

test('measureText scales linearly with font size', async () => {
  const { measureText } = await api();
  const small = measureText('Proportional Sample', { size: 10 }).width;
  const large = measureText('Proportional Sample', { size: 20 }).width;
  // A constant TEXT_PAD keeps the ratio just under 2, never above it.
  assert.ok(large / small > 1.7 && large / small <= 2.05, `ratio was ${(large / small).toFixed(3)}`);
});

test('measureText honours the per-character advance table', async () => {
  const { measureText } = await api();
  const opts = { size: 14 };
  const narrow = measureText('iiiiiiiiii', opts).width;
  const wide = measureText('MMMMMMMMMM', opts).width;
  const digits = measureText('0123456789', opts).width;
  const upper = measureText('ABCDEFGHIJ', opts).width;

  assert.ok(wide > narrow * 2, `wide/narrow ratio was ${(wide / narrow).toFixed(2)}, expected > 2`);
  assert.ok(wide / narrow < 4.5, `wide/narrow ratio was ${(wide / narrow).toFixed(2)}, expected < 4.5`);
  assert.ok(narrow < digits, 'narrow glyphs must be narrower than digits');
  assert.ok(digits < wide, 'digits must be narrower than `M`');
  assert.ok(upper > digits * 0.9, 'uppercase must be at least as wide as digits');
});

test('measureText: bold is wider, mono is uniform, CJK is full-width', async () => {
  const { measureText } = await api();
  const opts = { size: 14 };
  const normal = measureText('Proportional', opts).width;
  const bold = measureText('Proportional', { ...opts, weight: 'bold' }).width;
  assert.ok(bold > normal, 'bold text must measure wider than normal');
  assert.ok(bold < normal * 1.15, `bold was ${(bold / normal).toFixed(3)}x normal, expected ~1.04x`);

  const monoNarrow = measureText('iiii', { ...opts, mono: true }).width;
  const monoWide = measureText('MMMM', { ...opts, mono: true }).width;
  assert.equal(monoNarrow, monoWide, 'every mono glyph advances by the same amount');

  const cjk = measureText('漢字表示', opts).width;
  assert.ok(cjk >= 4 * 14 * 0.9, `CJK measured ${cjk}, expected ~${4 * 14} at 1.0em`);
});

test('measureText pins known strings within the documented accuracy target', async () => {
  const { measureText } = await api();
  // Analytic expectations from the §4 advance table at 14px. Over-estimating is safe, so
  // the upper bound is generous and the lower bound is what actually guards against a
  // character-count implementation.
  const cases = [
    ['Hello World', 76.0],
    ['iiiiiiiiii', 39.2],
    ['MMMMMMMMMM', 126.0],
    ['Deploy to production', 132.6],
  ];
  for (const [text, expected] of cases) {
    const { width } = measureText(text, { size: 14 });
    assert.ok(
      width >= expected * 0.8 && width <= expected * 1.25 + 10,
      `measureText(${JSON.stringify(text)}) = ${width.toFixed(1)}, expected ~${expected}`,
    );
  }
});

test('measureText is pure -- the same input always measures the same', async () => {
  const { measureText } = await api();
  const first = measureText('Deterministic', { size: 14 });
  const second = measureText('Deterministic', { size: 14 });
  assert.deepEqual(first, second);
});

test('wrapText greedily fills lines without dropping or reordering words', async () => {
  const { measureText, wrapText } = await api();
  const text = 'alpha beta gamma delta epsilon zeta eta theta';
  const lines = wrapText(text, 90, { size: 14 });
  assert.ok(Array.isArray(lines) && lines.length > 1, `expected several lines, got ${JSON.stringify(lines)}`);
  assert.deepEqual(lines.join(' ').split(/\s+/), text.split(' '), 'wrapping lost or reordered words');
  for (const line of lines) {
    if (line.trim().split(/\s+/).length === 1) continue; // a single long word may overflow
    assert.ok(
      measureText(line, { size: 14 }).width <= 90.5,
      `wrapped line ${JSON.stringify(line)} is wider than the 90px limit`,
    );
  }
});

test('wrapText returns one line when the text already fits', async () => {
  const { wrapText } = await api();
  assert.deepEqual(wrapText('short', 500, { size: 14 }), ['short']);
});

test('wrapText terminates on a single unbreakable word far wider than the limit', async () => {
  const { wrapText } = await api();
  const { ms, value } = timed(() => wrapText('x'.repeat(5000), 40, { size: 14 }));
  assert.ok(Array.isArray(value) && value.length >= 1);
  assert.ok(ms < BUDGET_MS, `wrapText took ${ms.toFixed(0)}ms on one 5000-char word`);
});

// ---------------------------------------------------------------------------
// Flowchart parsing -- SPEC-MERMAID §5a
// ---------------------------------------------------------------------------

/** Every node shape in the §5a table, with the class name it must produce. */
const SHAPE_CASES = [
  ['A[Text]', 'rect'],
  ['A(Text)', 'round'],
  ['A([Text])', 'stadium'],
  ['A[[Text]]', 'subroutine'],
  ['A[(Text)]', 'cylinder'],
  ['A((Text))', 'circle'],
  ['A{Text}', 'diamond'],
  ['A{{Text}}', 'hexagon'],
  ['A[/Text/]', 'parallelogram'],
  ['A[\\Text\\]', 'parallelogram-alt'],
  ['A>Text]', 'flag'],
];

for (const [declaration, shape] of SHAPE_CASES) {
  test(`flowchart parse: ${declaration} is a ${shape}`, async () => {
    const { parseFlow } = await api();
    const source = `graph TD\n  ${declaration} --> B\n`;
    const graph = asFlowGraph(parseFlow(source, parseContext()), source);
    const node = graph.nodes.get('A');
    assert.ok(node, `node A missing from ${declaration}`);
    assert.equal(node.shape, shape);
    assert.deepEqual(node.label, ['Text'], 'FlowNode.label is an array of lines');
    assert.equal(node.line, 2, 'FlowNode.line is 1-based within the diagram source');
  });
}

test('flowchart parse: a bare id is a rect labelled with the id', async () => {
  const { parseFlow } = await api();
  const source = 'graph TD\n  Alpha --> Beta\n';
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.deepEqual([...graph.nodes.keys()], ['Alpha', 'Beta'], 'nodes are insertion-ordered');
  assert.equal(graph.nodes.get('Alpha').shape, 'rect');
  assert.deepEqual(graph.nodes.get('Alpha').label, ['Alpha']);
});

/** Every edge kind in §5a. */
const EDGE_CASES = [
  ['-->', 'arrow'],
  ['---', 'open'],
  ['-.->', 'dotted'],
  ['==>', 'thick'],
  ['--x', 'cross'],
  ['--o', 'circle'],
];

for (const [operator, kind] of EDGE_CASES) {
  test(`flowchart parse: \`${operator}\` is a ${kind} edge`, async () => {
    const { parseFlow } = await api();
    const source = `graph TD\n  A ${operator} B\n`;
    const graph = asFlowGraph(parseFlow(source, parseContext()), source);
    assert.equal(graph.edges.length, 1);
    assert.deepEqual(
      { from: graph.edges[0].from, to: graph.edges[0].to, kind: graph.edges[0].kind },
      { from: 'A', to: 'B', kind },
    );
    assert.equal(graph.edges[0].label, null, 'an unlabelled edge has label null');
    assert.equal(graph.edges[0].line, 2);
  });
}

test('flowchart parse: both edge-label forms', async () => {
  const { parseFlow } = await api();
  const source = 'graph TD\n  A -->|yes| B\n  A -- no --> C\n';
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(graph.edges[0].label, ['yes']);
  assert.deepEqual(graph.edges[1].label, ['no']);
  assert.equal(graph.edges[1].kind, 'arrow');
});

test('flowchart parse: chains expand to one edge per link', async () => {
  const { parseFlow } = await api();
  const source = 'graph TD\n  A --> B --> C --> D\n';
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.deepEqual(
    graph.edges.map((e) => `${e.from}${e.to}`),
    ['AB', 'BC', 'CD'],
  );
});

test('flowchart parse: `&` multi-target on either side', async () => {
  const { parseFlow } = await api();
  const fanOut = asFlowGraph(parseFlow('graph TD\n  A --> B & C\n', parseContext()), 'fan out');
  assert.deepEqual(fanOut.edges.map((e) => `${e.from}${e.to}`).sort(), ['AB', 'AC']);

  const fanIn = asFlowGraph(parseFlow('graph TD\n  A & B --> C\n', parseContext()), 'fan in');
  assert.deepEqual(fanIn.edges.map((e) => `${e.from}${e.to}`).sort(), ['AC', 'BC']);

  const both = asFlowGraph(parseFlow('graph TD\n  A & B --> C & D\n', parseContext()), 'both');
  assert.deepEqual(both.edges.map((e) => `${e.from}${e.to}`).sort(), ['AC', 'AD', 'BC', 'BD']);
});

test('flowchart parse: all five direction spellings, TB folded onto TD', async () => {
  const { parseFlow } = await api();
  const expected = { TD: 'TD', TB: 'TD', BT: 'BT', LR: 'LR', RL: 'RL' };
  for (const [written, normalised] of Object.entries(expected)) {
    for (const keyword of ['graph', 'flowchart']) {
      const source = `${keyword} ${written}\n  A --> B\n`;
      const graph = asFlowGraph(parseFlow(source, parseContext()), source);
      assert.equal(graph.direction, normalised, `${keyword} ${written}`);
    }
  }
});

test('flowchart parse: quoted labels, <br/> breaks and entities', async () => {
  const { parseFlow } = await api();
  const source = [
    'graph TD',
    '  A["Commas, brackets [x] and --> arrows"] --> B',
    '  B --> C["First<br/>Second<br>Third"]',
    '  C --> D["Caf&eacute; &amp; bar"]',
    '',
  ].join('\n');
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.deepEqual(graph.nodes.get('A').label, ['Commas, brackets [x] and --> arrows']);
  assert.deepEqual(graph.nodes.get('C').label, ['First', 'Second', 'Third']);
  const cafe = graph.nodes.get('D').label.join('');
  assert.ok(/Caf(é|&eacute;)/.test(cafe) && /&(amp;)? ?bar|& bar/.test(cafe), `entities: ${cafe}`);
});

test('flowchart parse: `%%` comments are ignored, including whole-line ones', async () => {
  const { parseFlow } = await api();
  const source = 'graph TD\n  %% this is a comment --> and not an edge\n  A --> B\n';
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual([...graph.nodes.keys()], ['A', 'B']);
});

test('flowchart parse: subgraphs nest and record their members', async () => {
  const { parseFlow } = await api();
  // Every id is introduced inside the block that should own it: a node first mentioned
  // outside a subgraph belongs outside it, so reusing one here would make the expectation
  // ambiguous rather than testing anything.
  const source = [
    'graph TD',
    '  A --> B',
    '  subgraph Outer',
    '    direction LR',
    '    subgraph Inner',
    '      C --> D',
    '    end',
    '    E --> F',
    '  end',
    '  B --> C',
    '  F --> G',
    '',
  ].join('\n');
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.equal(graph.subgraphs.length, 1, 'only the outermost subgraph is a root');
  const outer = graph.subgraphs[0];
  assert.equal(outer.title, 'Outer');
  assert.equal(outer.direction, 'LR', '`direction` inside a subgraph is recorded');
  assert.equal(outer.children.length, 1);
  assert.equal(outer.children[0].title, 'Inner');
  assert.deepEqual(outer.children[0].nodeIds.slice().sort(), ['C', 'D']);
  for (const id of ['E', 'F']) {
    assert.ok(
      outer.nodeIds.includes(id),
      `Outer should own ${id} directly, got ${JSON.stringify(outer.nodeIds)}`,
    );
  }
  for (const id of ['A', 'B', 'G']) {
    assert.ok(!outer.nodeIds.includes(id), `${id} is outside every subgraph`);
  }
});

test('flowchart parse: classDef, `class` and `:::` land in FlowNode.classes', async () => {
  const { parseFlow } = await api();
  const source = [
    'graph TD',
    '  classDef danger fill:#f00,stroke:#900',
    '  A[Boom]:::danger --> B',
    '  B --> C',
    '  class B,C danger',
    '',
  ].join('\n');
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  for (const id of ['A', 'B', 'C']) {
    assert.ok(
      (graph.nodes.get(id).classes || []).includes('danger'),
      `node ${id} did not pick up the \`danger\` class`,
    );
  }
});

test('flowchart parse: `click`, `style` and `linkStyle` are parsed and ignored', async () => {
  const { parseFlow } = await api();
  const source = [
    'graph TD',
    '  A --> B',
    '  click A "https://example.com" "Tooltip"',
    '  style A fill:#f9f,stroke:#333',
    '  linkStyle 0 stroke:#f00',
    '',
  ].join('\n');
  const graph = asFlowGraph(parseFlow(source, parseContext()), source);
  assert.equal(graph.edges.length, 1, 'ignored statements must not become edges');
  assert.deepEqual([...graph.nodes.keys()], ['A', 'B'], 'ignored statements must not become nodes');
});

// ---------------------------------------------------------------------------
// Layout invariants, table-driven -- SPEC-MERMAID §10
// ---------------------------------------------------------------------------

for (const fixture of FLOW_FIXTURES) {
  test(`layout invariants: ${fixture.name}`, async () => {
    const { flowConst } = await api();
    const { graph, positioned } = await flowFixture(fixture.source);
    const label = fixture.name;

    assert.equal(
      positioned.nodes.length,
      graph.nodes.size,
      `${label}: every parsed node must be positioned`,
    );

    assertNoNodeOverlap(positioned, label);
    assertNodesInsideSubgraphs(positioned, graph, label);
    assertEdgeEndpointsOnOutline(positioned, 1, label);
    assertMinimumSeparation(
      positioned,
      flowConst('LAYER_GAP'),
      flowConst('NODE_GAP'),
      fixture.direction,
      label,
    );
    assertContentBounds(positioned, label);

    if (fixture.crossings !== undefined) {
      assert.equal(
        countEdgeCrossings(positioned),
        fixture.crossings,
        `${label}: expected ${fixture.crossings} edge crossings`,
      );
    }
    if (fixture.subgraphs) {
      assert.equal(
        (positioned.subgraphs || []).length,
        flattenSubgraphs(graph).length,
        `${label}: every subgraph, at every nesting depth, needs a box`,
      );
    }
  });
}

test('layout: node sizes respect MIN_W/MIN_H and snap to a 2px grid', async () => {
  const { flowConst } = await api();
  const { positioned } = await flowFixture('graph TD\n  A --> B\n  B --> C[A much longer label here]\n');
  for (const node of positioned.nodes) {
    assert.ok(node.w >= flowConst('MIN_W'), `node ${node.id} is ${node.w}px wide, below MIN_W`);
    assert.ok(node.h >= flowConst('MIN_H'), `node ${node.id} is ${node.h}px tall, below MIN_H`);
    assert.equal(node.w % 2, 0, `node ${node.id} width ${node.w} is not snapped to a 2px grid`);
    assert.equal(node.h % 2, 0, `node ${node.id} height ${node.h} is not snapped to a 2px grid`);
  }
});

test('layout: a node grows to fit its wrapped label plus shape padding', async () => {
  const { flowConst, measureText } = await api();
  const { positioned } = await flowFixture('graph TD\n  A[Short] --> B[A considerably longer label]\n');
  const short = positioned.nodes.find((n) => n.id === 'A');
  const long = positioned.nodes.find((n) => n.id === 'B');
  assert.ok(long.w > short.w, 'a longer label must produce a wider node');
  const widest = Math.max(...long.label.map((line) => measureText(line).width));
  assert.ok(
    long.w >= widest + 2 * flowConst('NODE_PAD_X') - 2,
    `node B is ${long.w}px wide but its widest line measures ${widest.toFixed(1)}px `
    + `plus 2x NODE_PAD_X`,
  );
});

test('layout: a long edge is routed as a polyline through intermediate layers', async () => {
  // A --> D spans three layers, so §5b step 4 requires dummy nodes and therefore bends.
  const { positioned } = await flowFixture('graph TD\n  A --> B --> C --> D\n  A --> D\n');
  const long = positioned.edges.find((e) => e.from === 'A' && e.to === 'D');
  assert.ok(long, 'the A->D edge is missing');
  assert.ok(
    long.points.length > 2,
    'an edge spanning three layers must be routed through intermediate points, '
    + `got ${long.points.length}`,
  );
  const rects = positioned.nodes.map(nodeRect);
  for (const point of long.points.slice(1, -1)) {
    for (const rect of rects) {
      const inside = point.x > rect.x0 + 1 && point.x < rect.x1 - 1
        && point.y > rect.y0 + 1 && point.y < rect.y1 - 1;
      assert.ok(!inside, `the A->D route passes through node ${rect.id}`);
    }
  }
});

test('layout: a cyclic graph terminates and keeps its edges pointing the original way', async () => {
  const { positioned } = await flowFixture('graph TD\n  A --> B\n  B --> C\n  C --> A\n');
  assert.deepEqual(
    positioned.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['A->B', 'B->C', 'C->A'],
    'a reversed back edge must be flipped back before routing',
  );
  assertNoNodeOverlap(positioned, 'cycle');
  assertEdgeEndpointsOnOutline(positioned, 1, 'cycle');
});

test('layout: edge labels are positioned and stay inside the content box', async () => {
  const { positioned } = await flowFixture('graph TD\n  A -->|a label| B\n  A -- another --> C\n');
  const labelled = positioned.edges.filter((e) => e.label);
  assert.equal(labelled.length, 2, 'both labelled edges must survive layout');
  for (const edge of labelled) {
    assert.ok(edge.labelPos, `edge ${edge.from}->${edge.to} has a label but no labelPos`);
    assert.ok(finite(edge.labelPos.x) && finite(edge.labelPos.y), 'labelPos must be finite');
    assert.ok(
      edge.labelPos.x >= 0 && edge.labelPos.x <= positioned.width
      && edge.labelPos.y >= 0 && edge.labelPos.y <= positioned.height,
      `labelPos ${JSON.stringify(edge.labelPos)} is outside the content box`,
    );
  }
  for (const edge of positioned.edges) {
    if (!edge.label) assert.equal(edge.labelPos, null, 'an unlabelled edge has labelPos null');
  }
});

test('layout: a subgraph box is inset by SUB_PAD and leaves room for its title', async () => {
  const { flowConst } = await api();
  const source = 'graph TD\n  subgraph Group\n    A --> B\n  end\n  B --> C\n';
  const { graph, positioned } = await flowFixture(source);
  const { rects } = subgraphRects(positioned, graph);
  const box = rects.find((r) => r.title === 'Group');
  assert.ok(box, 'the subgraph box is missing');
  const members = positioned.nodes.filter((n) => ['A', 'B'].includes(n.id)).map(nodeRect);
  const pad = flowConst('SUB_PAD');
  const left = Math.min(...members.map((m) => m.x0)) - box.x0;
  const right = box.x1 - Math.max(...members.map((m) => m.x1));
  const bottom = box.y1 - Math.max(...members.map((m) => m.y1));
  const top = Math.min(...members.map((m) => m.y0)) - box.y0;
  assert.ok(left >= pad - 0.5, `left inset was ${left.toFixed(1)}, expected >= ${pad}`);
  assert.ok(right >= pad - 0.5, `right inset was ${right.toFixed(1)}, expected >= ${pad}`);
  assert.ok(bottom >= pad - 0.5, `bottom inset was ${bottom.toFixed(1)}, expected >= ${pad}`);
  assert.ok(top >= pad, `top inset was ${top.toFixed(1)}, expected >= ${pad} plus a title band`);

  // C is outside the group, so the box must not reach it.
  const outside = nodeRect(positioned.nodes.find((n) => n.id === 'C'));
  assert.ok(!boxesOverlap(box, outside), 'the subgraph box swallowed a node that is not a member');
});

test('layout: crossing reduction beats the naive ordering on a graph designed to cross', async () => {
  // Declared so that a layout which keeps declaration order in layer 2 crosses both edges;
  // any working median/barycentre sweep reorders them and reaches zero.
  const source = 'graph TD\n  A1 --> B2\n  A2 --> B1\n  B1 --> C1\n  B2 --> C1\n';
  const { positioned } = await flowFixture(source);
  assert.equal(countEdgeCrossings(positioned), 0, 'crossing reduction did not run');
});

test('layout: chains of dummies are straightened, so a long edge is visually straight', async () => {
  const { positioned } = await flowFixture(
    'graph TD\n  A --> B --> C --> D --> E\n  A --> E\n',
  );
  const long = positioned.edges.find((e) => e.from === 'A' && e.to === 'E');
  const points = long.points;
  assert.ok(points.length >= 3, 'the long edge should route through intermediate positions');

  // A straightened chain never doubles back: one jog off the source and one onto the
  // target are fine, a zigzag between them is exactly what step 6 is meant to remove.
  const steps = [];
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    if (Math.abs(dx) > 0.5) steps.push(Math.sign(dx));
  }
  assert.ok(
    new Set(steps).size <= 1,
    `the A->E route changes horizontal direction ${new Set(steps).size} times: `
    + JSON.stringify(points),
  );

  // And most of the descent happens on one straight spine rather than in small hops.
  let spine = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i].x - points[i - 1].x) <= 0.5) {
      spine = Math.max(spine, Math.abs(points[i].y - points[i - 1].y));
    }
  }
  const travel = Math.abs(points[points.length - 1].y - points[0].y);
  assert.ok(
    spine >= travel * 0.6,
    `the longest straight run is ${spine.toFixed(1)}px of ${travel.toFixed(1)}px of descent`,
  );
});

// ---------------------------------------------------------------------------
// The entry point -- SPEC-MERMAID §2
// ---------------------------------------------------------------------------

/**
 * Render one diagram through the public entry point.
 * @param {string} source
 * @param {object} [opts]
 * @returns {Promise<{svg: string|null, kind: string|null, diagnostics: object[]}>}
 */
async function renderDiagram(source, opts = {}) {
  const { renderMermaid } = await api();
  const out = renderMermaid(source, { file: 'test.md', line: 1, index: 1, ...opts });
  assert.ok(out && typeof out === 'object', 'renderMermaid must return an object');
  assert.ok(Array.isArray(out.diagnostics), 'renderMermaid must return a `diagnostics` array');
  assert.ok('svg' in out && 'kind' in out, 'renderMermaid must return `svg` and `kind`');
  return out;
}

/**
 * Render a diagram that is expected to succeed, returning its `<svg>` element.
 * @param {string} source
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
async function renderSvg(source, opts = {}) {
  const out = await renderDiagram(source, opts);
  assert.ok(
    out.svg,
    `renderMermaid returned null for:\n${source}\ndiagnostics: `
    + `${out.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`,
  );
  return svgElement(out.svg);
}

test('renderMermaid dispatches on the diagram type', async () => {
  const flow = await renderDiagram('graph TD\n  A --> B\n');
  assert.equal(flow.kind, 'flowchart');
  assert.ok(flow.svg);

  const sequence = await renderDiagram('sequenceDiagram\n  A->>B: hi\n');
  assert.equal(sequence.kind, 'sequence');
  assert.ok(sequence.svg);

  const blank = await renderDiagram('\n\n%% just a comment\ngraph LR\n  A --> B\n');
  assert.equal(blank.kind, 'flowchart', 'dispatch skips blank and comment lines');
});

// ---------------------------------------------------------------------------
// Sequence diagrams -- SPEC-MERMAID §6a / §6b
// ---------------------------------------------------------------------------

test('sequence parse: every arrow form produces one message', async () => {
  const source = SEQUENCE_FIXTURES[0].source;
  const { positioned } = await sequenceFixture(source);
  const messages = seqMessages(positioned);
  assert.equal(messages.length, 6, 'all six arrow forms must parse');
  const kinds = new Set(messages.map((m) => m.kind));
  assert.equal(kinds.size, 6, `each arrow form needs a distinct kind, got ${[...kinds].join(', ')}`);
  assert.deepEqual(
    messages.map((m) => (Array.isArray(m.label) ? m.label.join(' ') : m.label)),
    ['solid arrow', 'dashed arrow', 'open arrow', 'async dashed', 'async open', 'cross'],
  );
});

test('sequence parse: participants keep declaration order and their `as` label', async () => {
  const { positioned } = await sequenceFixture(SEQUENCE_FIXTURES[0].source);
  const participants = seqParticipants(positioned);
  assert.deepEqual(participants.map((p) => p.id), ['A', 'B']);
  const labels = participants.map((p) => {
    const l = p.raw.label;
    return Array.isArray(l) ? l.join(' ') : l;
  });
  assert.deepEqual(labels, ['Client', 'Server']);
});

test('sequence parse: undeclared participants are auto-created in first-appearance order', async () => {
  const out = await renderDiagram('sequenceDiagram\n  B->>A: one\n  C->>A: two\n');
  assert.ok(out.svg, 'the diagram must still render');
  const { positioned } = await sequenceFixture('sequenceDiagram\n  B->>A: one\n  C->>A: two\n');
  assert.deepEqual(seqParticipants(positioned).map((p) => p.id), ['B', 'A', 'C']);
  assert.ok(
    out.diagnostics.some((d) => d.code === 'MD082'),
    'auto-creating a participant must report MD082',
  );
});

test('sequence render: notes appear for all three placements', async () => {
  const svg = await renderSvg(SEQUENCE_FIXTURES[1].source);
  assert.equal(count(svg, /class="[^"]*\bdg-note\b/g), 3, 'one group per note');
  const texts = svgTexts(svg, 'dg-note__label').join(' | ');
  for (const expected of ['on the left', 'on the right', 'spanning both']) {
    assert.ok(texts.includes(expected), `note text ${JSON.stringify(expected)} is missing`);
  }
});

test('sequence render: loop/alt/else/opt/par frames and their dividers', async () => {
  const svg = await renderSvg(SEQUENCE_FIXTURES[2].source);
  assert.equal(count(svg, /class="[^"]*\bdg-block\b/g), 4, 'loop, alt, opt and par each need a frame');
  assert.ok(count(svg, /class="[^"]*\bdg-block__frame\b/g) >= 4);
  assert.ok(count(svg, /class="[^"]*\bdg-block__tab\b/g) >= 4, 'each frame has a tab in the top-left');
  const labels = svgTexts(svg, 'dg-block__label').join(' | ');
  for (const expected of ['every minute', 'cache hit', 'cache miss', 'debugging', 'fan out', 'also']) {
    assert.ok(labels.includes(expected), `block label ${JSON.stringify(expected)} is missing`);
  }
  assert.ok(
    count(svg, /class="[^"]*\bdg-block__divider\b/g) >= 2,
    '`else` and `and` each draw a dashed divider',
  );
});

test('sequence render: autonumber prefixes sequential numbers', async () => {
  const svg = await renderSvg(SEQUENCE_FIXTURES[5].source);
  const labels = svgTexts(svg, 'dg-message__label');
  assert.equal(labels.length, 3);
  assert.ok(/^\s*1/.test(labels[0]), `first label was ${JSON.stringify(labels[0])}`);
  assert.ok(/^\s*2/.test(labels[1]), `second label was ${JSON.stringify(labels[1])}`);
  assert.ok(/^\s*3/.test(labels[2]), `third label was ${JSON.stringify(labels[2])}`);

  const without = await renderSvg('sequenceDiagram\n  A->>B: first\n  B->>A: second\n');
  assert.ok(
    !/^\s*1/.test(svgTexts(without, 'dg-message__label')[0]),
    'numbers must only appear when `autonumber` was requested',
  );
});

test('sequence layout: explicit and implicit activations produce nested bars', async () => {
  const { positioned } = await sequenceFixture(SEQUENCE_FIXTURES[3].source);
  const bars = seqActivations(positioned);
  assert.ok(bars.length >= 3, `expected at least three activation bars, got ${bars.length}`);
  assertActivationsNest(positioned, 'activations');

  const { seqConst } = await api();
  for (const bar of bars) {
    if (bar.w !== null) assert.equal(bar.w, seqConst('ACTIVATION_W'), 'activation bars are ACTIVATION_W wide');
  }
  const onB = bars.filter((b) => b.participant === 'B');
  assert.ok(onB.length >= 2, 'B is activated twice, once nested inside the other');
  assert.ok(
    Math.max(...onB.map((b) => b.depth)) > Math.min(...onB.map((b) => b.depth)),
    'the nested activation on B must sit at a greater depth',
  );
});

test('sequence layout: a self-message adds height and loops beside its own lifeline', async () => {
  const plain = await sequenceFixture('sequenceDiagram\n  participant A\n  participant B\n  A->>B: x\n');
  const looped = await sequenceFixture(
    'sequenceDiagram\n  participant A\n  participant B\n  A->>A: a self message\n  A->>B: x\n',
  );
  assert.ok(
    looped.positioned.height > plain.positioned.height,
    'a self-message must add vertical space',
  );
  const self = seqMessages(looped.positioned).find((m) => m.from === m.to);
  assert.ok(self, 'the self-message is missing from the layout');
});

for (const fixture of SEQUENCE_FIXTURES) {
  test(`sequence layout invariants: ${fixture.name}`, async () => {
    const { measureText, seqConst } = await api();
    const { positioned } = await sequenceFixture(fixture.source);
    const label = fixture.name;

    assert.ok(finite(positioned.width) && positioned.width > 0, `${label}: width must be positive`);
    assert.ok(finite(positioned.height) && positioned.height > 0, `${label}: height must be positive`);

    const participants = seqParticipants(positioned);
    // Columns are laid out left to right, never closer than PARTICIPANT_GAP.
    for (let i = 1; i < participants.length; i += 1) {
      const prev = participants[i - 1];
      const here = participants[i];
      assert.ok(here.x > prev.x, `${label}: participant ${here.id} is not right of ${prev.id}`);
      const gap = (here.x - here.w / 2) - (prev.x + prev.w / 2);
      assert.ok(
        gap >= seqConst('PARTICIPANT_GAP') - 0.5,
        `${label}: ${prev.id} and ${here.id} are only ${gap.toFixed(1)}px apart `
        + `(minimum ${seqConst('PARTICIPANT_GAP')})`,
      );
    }

    // Rows advance monotonically down the diagram.
    const ys = seqMessages(positioned).map((m) => m.y);
    for (const y of ys) assert.ok(finite(y), `${label}: a message has a non-finite y`);
    for (let i = 1; i < ys.length; i += 1) {
      assert.ok(ys[i] >= ys[i - 1], `${label}: message rows must not move back up the page`);
    }

    assertNoLabelLifelineOverlap(positioned, measureText, label);
    assertActivationsNest(positioned, label);
  });
}

test('sequence layout: neighbouring columns widen so a long label still fits between them', async () => {
  const { measureText } = await api();
  const short = await sequenceFixture('sequenceDiagram\n  participant A\n  participant B\n  A->>B: hi\n');
  const long = await sequenceFixture(
    'sequenceDiagram\n  participant A\n  participant B\n'
    + '  A->>B: an extremely long message label that has to fit between two lifelines\n',
  );
  const gapOf = (fx) => {
    const [a, b] = seqParticipants(fx.positioned);
    return b.x - a.x;
  };
  assert.ok(
    gapOf(long) > gapOf(short),
    'a long message label must widen the column gap, not overflow it',
  );
  assertNoLabelLifelineOverlap(long.positioned, measureText, 'widened columns');
});

test('sequence layout: participant boxes repeat once the diagram passes REPEAT_HEADER_AFTER', async () => {
  const { seqConst } = await api();
  const lines = ['sequenceDiagram', '  participant A', '  participant B'];
  for (let i = 0; i < 40; i += 1) lines.push(`  A->>B: message ${i}`);
  const svg = await renderSvg(`${lines.join('\n')}\n`);
  const { positioned } = await sequenceFixture(`${lines.join('\n')}\n`);
  assert.ok(
    positioned.height > seqConst('REPEAT_HEADER_AFTER'),
    'the fixture must be tall enough to trigger the repeated header',
  );
  assert.equal(
    count(svg, /class="[^"]*\bdg-participant__box\b/g),
    4,
    'two participants, drawn at the top and repeated at the bottom',
  );
});

// ---------------------------------------------------------------------------
// SVG output contract -- SPEC-MERMAID §7
// ---------------------------------------------------------------------------

test('svg: the root element carries the pinned attributes', async () => {
  const svg = await renderSvg('graph TD\n  A[One] --> B[Two]\n');
  const root = svg.slice(0, svg.indexOf('>') + 1);
  assert.equal(attrOf(root, 'class'), 'diagram__svg');
  assert.equal(attrOf(root, 'preserveAspectRatio'), 'xMidYMid meet');
  assert.equal(attrOf(root, 'xmlns'), 'http://www.w3.org/2000/svg');

  const viewBox = attrOf(root, 'viewBox');
  assert.ok(viewBox, 'a viewBox is required');
  const [minX, minY, w, h] = viewBox.split(/\s+/).map(Number);
  // §7 pins `viewBox="0 0 W H"`. A negative origin is a tempting way to add a margin, but
  // the contract wants the margin folded into the coordinates so that W/H, the width and
  // height attributes and the content box all agree.
  assert.equal(minX, 0, `viewBox origin must be 0 0, got "${viewBox}"`);
  assert.equal(minY, 0, `viewBox origin must be 0 0, got "${viewBox}"`);
  assert.ok(w > 0 && h > 0, `viewBox dimensions were ${w}x${h}`);
  // width/height are present so the diagram still has intrinsic size without CSS.
  assert.equal(Number(attrOf(root, 'width')), w);
  assert.equal(Number(attrOf(root, 'height')), h);
});

test('svg: title and desc are present for assistive technology', async () => {
  const svg = await renderSvg('graph TD\n  A[Ingest] --> B[Store]\n');
  assert.match(svg, /<title>[^<]+<\/title>/, 'the SVG needs a <title>');
  assert.match(svg, /<desc>[\s\S]*?<\/desc>/, 'the SVG needs a <desc>');
});

test('svg: the structural groups of §7 are emitted in order', async () => {
  const svg = await renderSvg('graph TD\n  subgraph G\n    A --> B\n  end\n');
  const subgraphs = svg.indexOf('<g class="dg-subgraphs"');
  const edges = svg.indexOf('<g class="dg-edges"');
  const nodes = svg.indexOf('<g class="dg-nodes"');
  assert.ok(subgraphs >= 0, 'missing <g class="dg-subgraphs">');
  assert.ok(edges > subgraphs, 'edges must be painted after subgraph boxes');
  assert.ok(nodes > edges, 'nodes must be painted over edges');
  assert.match(svg, /<rect class="dg-subgraph__box"/);
  assert.match(svg, /<text class="dg-subgraph__title"/);
  assert.match(svg, /class="dg-edge dg-edge--/);
  assert.match(svg, /<path class="dg-edge__line"/);
  assert.match(svg, /<path class="dg-node__shape"/);
  assert.match(svg, /<text class="dg-node__label"/);
});

test('svg: node groups carry a shape modifier and any classDef classes', async () => {
  const svg = await renderSvg('graph TD\n  classDef danger fill:#f00\n  A{Decide}:::danger --> B[Go]\n');
  assert.match(svg, /class="dg-node dg-node--diamond[^"]*\bnode--danger\b/);
  assert.match(svg, /class="dg-node dg-node--rect"/);
});

test('svg: edge groups carry a kind modifier', async () => {
  const svg = await renderSvg('graph LR\n  A -.-> B\n  B ==> C\n  C --x D\n');
  for (const kind of ['dotted', 'thick', 'cross']) {
    assert.match(svg, new RegExp(`class="dg-edge dg-edge--${kind}"`), `missing dg-edge--${kind}`);
  }
});

test('svg: multi-line labels use one tspan per line with an explicit x', async () => {
  const svg = await renderSvg('graph TD\n  A["First<br/>Second"] --> B\n');
  const label = /<text class="dg-node__label"[^>]*>([\s\S]*?)<\/text>/.exec(svg);
  assert.ok(label, 'no node label found');
  const tspans = [...label[1].matchAll(/<tspan\b([^>]*)>/g)].map((m) => `<x${m[1]}>`);
  assert.equal(tspans.length, 2, 'one tspan per line');
  for (const tspan of tspans) {
    assert.ok(attrOf(tspan, 'x') !== null, `tspan without an explicit x: ${tspan}`);
  }
  // Safari does not agree with other engines about dominant-baseline on multi-line text,
  // so the first line's position must be computed, not inherited.
  assert.ok(
    attrOf(tspans[0], 'dy') !== null || attrOf(tspans[0], 'y') !== null,
    'the first tspan needs an explicit dy or y',
  );
  assert.ok(attrOf(tspans[1], 'dy') !== null, 'subsequent tspans advance with dy');
});

test('svg: colour lives in CSS -- no style, fill or stroke attributes anywhere', async () => {
  for (const source of ['graph TD\n  A --> B\n', 'sequenceDiagram\n  A->>B: hi\n']) {
    const svg = await renderSvg(source);
    assert.equal(count(svg, /\sstyle="/g), 0, `inline style= attribute in:\n${source}`);
    assert.equal(count(svg, /\sfill="/g), 0, `inline fill= attribute in:\n${source}`);
    assert.equal(count(svg, /\sstroke="/g), 0, `inline stroke= attribute in:\n${source}`);
  }
});

test('svg: marker ids are unique, deterministic and per-diagram', async () => {
  const first = await renderSvg('graph TD\n  A --> B\n', { index: 1 });
  const second = await renderSvg('graph TD\n  A --> B\n', { index: 2 });

  const idsOf = (svg) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const firstIds = idsOf(first);
  assert.ok(firstIds.length > 0, 'a diagram with an arrow needs at least one marker id');
  assert.equal(new Set(firstIds).size, firstIds.length, 'ids must be unique within one diagram');
  assert.ok(
    firstIds.every((id) => /^d\d+-/.test(id)),
    `every id needs a per-diagram prefix, got ${firstIds.join(', ')}`,
  );

  const secondIds = idsOf(second);
  assert.equal(
    firstIds.filter((id) => secondIds.includes(id)).length,
    0,
    'two diagrams on one page must not share marker ids',
  );

  // Every reference resolves inside the same document.
  for (const svg of [first, second]) {
    const declared = new Set(idsOf(svg));
    for (const match of svg.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(declared.has(match[1]), `marker reference #${match[1]} has no definition`);
    }
  }
});

test('svg: the sequence diagram emits its own class vocabulary', async () => {
  const svg = await renderSvg(SEQUENCE_FIXTURES[3].source);
  const tokens = new Set(classTokens(svg));
  for (const cls of [
    'dg-lifeline', 'dg-participant', 'dg-participant__box', 'dg-participant__label',
    'dg-activation', 'dg-message', 'dg-message__line', 'dg-message__label',
  ]) {
    assert.ok(tokens.has(cls), `missing class ${cls}`);
  }
});

// ---------------------------------------------------------------------------
// Determinism -- SPEC-MERMAID §0 / §10
// ---------------------------------------------------------------------------

test('determinism: rendering the same source twice is byte-identical', async () => {
  for (const fixture of [...FLOW_FIXTURES, ...SEQUENCE_FIXTURES]) {
    const first = await renderDiagram(fixture.source);
    const second = await renderDiagram(fixture.source);
    assert.equal(second.svg, first.svg, `${fixture.name} did not render identically twice`);
    assert.equal(second.kind, first.kind);
    assert.deepEqual(second.diagnostics, first.diagnostics, `${fixture.name} diagnostics differ`);
  }
});

test('determinism: layout coordinates are reproducible', async () => {
  for (const fixture of FLOW_FIXTURES) {
    const first = await flowFixture(fixture.source);
    const second = await flowFixture(fixture.source);
    assert.equal(
      JSON.stringify(second.positioned),
      JSON.stringify(first.positioned),
      `${fixture.name} laid out differently on the second run`,
    );
  }
});

test('determinism: node and edge order follows the source, not a hash walk', async () => {
  const source = 'graph TD\n  zulu --> alpha\n  alpha --> mike\n  mike --> zulu\n';
  const { graph } = await flowFixture(source);
  assert.deepEqual([...graph.nodes.keys()], ['zulu', 'alpha', 'mike']);
  assert.deepEqual(graph.edges.map((e) => `${e.from}->${e.to}`), ['zulu->alpha', 'alpha->mike', 'mike->zulu']);
});

// ---------------------------------------------------------------------------
// Robustness -- SPEC-MERMAID §10, every case under BUDGET_MS
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} StressCase
 * @property {string} name
 * @property {() => string} build
 * @property {boolean} [mustRender] whether an SVG is still expected
 */

/** @type {StressCase[]} */
const STRESS_CASES = [
  {
    name: '300-node chain (exactly at the node limit)',
    mustRender: true,
    build: () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 299; i += 1) lines.push(`  n${i} --> n${i + 1}`);
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: 'complete graph K12',
    mustRender: true,
    build: () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 12; i += 1) {
        for (let j = i + 1; j < 12; j += 1) lines.push(`  n${i} --> n${j}`);
      }
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: '20 levels of nested subgraphs',
    mustRender: true,
    build: () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 20; i += 1) lines.push(`${'  '.repeat(i + 1)}subgraph S${i}`);
      lines.push(`${'  '.repeat(21)}A --> B`);
      for (let i = 19; i >= 0; i -= 1) lines.push(`${'  '.repeat(i + 1)}end`);
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: 'a 5000-character node label',
    mustRender: true,
    build: () => `graph TD\n  A["${'word '.repeat(1000)}"] --> B\n`,
  },
  {
    name: 'a 5000-character unbroken node label',
    mustRender: true,
    build: () => `graph TD\n  A["${'x'.repeat(5000)}"] --> B\n`,
  },
  {
    name: 'unbalanced activate',
    build: () => 'sequenceDiagram\n  participant A\n  activate A\n  A->>B: work\n',
  },
  {
    name: 'unbalanced deactivate',
    build: () => 'sequenceDiagram\n  participant A\n  deactivate A\n  deactivate A\n',
  },
  {
    name: 'unclosed subgraph',
    build: () => 'graph TD\n  subgraph Never\n    A --> B\n',
  },
  {
    name: 'unclosed sequence block',
    build: () => 'sequenceDiagram\n  loop forever\n    A->>B: tick\n',
  },
  {
    name: 'a 100-node cycle',
    mustRender: true,
    build: () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 100; i += 1) lines.push(`  n${i} --> n${(i + 1) % 100}`);
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: 'every node points at every other in a 30-node star both ways',
    mustRender: true,
    build: () => {
      const lines = ['graph LR'];
      for (let i = 0; i < 30; i += 1) lines.push(`  hub --> n${i}`, `  n${i} --> hub`);
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: 'a self-loop on every node',
    mustRender: true,
    build: () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 20; i += 1) lines.push(`  n${i} --> n${i}`, `  n${i} --> n${(i + 1) % 20}`);
      return `${lines.join('\n')}\n`;
    },
  },
  {
    name: '2000 lines of punctuation soup',
    build: () => `graph TD\n${'  }{][)(><--.=@#$%^\n'.repeat(2000)}`,
  },
  {
    name: 'unterminated quoted label',
    build: () => 'graph TD\n  A["never closed --> B\n  B --> C\n',
  },
  {
    name: '400 sequence messages between 60 participants',
    mustRender: true,
    build: () => {
      const lines = ['sequenceDiagram'];
      for (let i = 0; i < 60; i += 1) lines.push(`  participant p${i}`);
      for (let i = 0; i < 400; i += 1) lines.push(`  p${i % 60}->>p${(i + 1) % 60}: step ${i}`);
      return `${lines.join('\n')}\n`;
    },
  },
];

for (const stress of STRESS_CASES) {
  test(`robustness: ${stress.name}`, async () => {
    const { renderMermaid } = await api();
    const source = stress.build();
    const { ms, value } = timed(() => renderMermaid(source, { file: 'test.md', line: 1, index: 1 }));
    assert.ok(
      ms < BUDGET_MS,
      `${stress.name} took ${ms.toFixed(0)}ms (budget ${BUDGET_MS}ms) for ${source.length} bytes`,
    );
    assert.ok(Array.isArray(value.diagnostics), 'a diagnostics array is required even on failure');
    if (stress.mustRender) {
      assert.ok(
        value.svg,
        `${stress.name} should still render; diagnostics: `
        + value.diagnostics.map((d) => d.code).join(', '),
      );
    } else {
      // Degrading is fine; hanging, throwing or emitting a broken SVG is not.
      if (value.svg) svgElement(value.svg);
    }
  });
}

test('robustness: an empty or comment-only diagram degrades without throwing', async () => {
  for (const source of ['', '\n\n', '%% only a comment\n', 'graph TD\n', 'sequenceDiagram\n']) {
    const out = await renderDiagram(source);
    assert.ok(out.svg === null || typeof out.svg === 'string', `bad svg for ${JSON.stringify(source)}`);
  }
});

// ---------------------------------------------------------------------------
// Security -- SPEC-MERMAID §7 ("escape all text with escapeHtml")
// ---------------------------------------------------------------------------

test('security: label text is escaped, never emitted as markup', async () => {
  const source = [
    'graph TD',
    '  A["<script>alert(1)</script>"] --> B["a & b"]',
    '  B --> C["]]> and </text> and </svg>"]',
    '  C --> D["<img src=x onerror=alert(1)>"]',
    '  D --> E["</g><foreignObject>nope</foreignObject>"]',
    '',
  ].join('\n');
  const svg = await renderSvg(source);

  assert.ok(!/<script/i.test(svg), 'a <script> tag reached the SVG');
  assert.ok(!/<img/i.test(svg), 'an <img> element reached the SVG');
  // `onerror` as escaped *text* is correct output, so only live markup is inspected.
  for (const tag of svg.matchAll(/<[a-zA-Z][^>]*>/g)) {
    assert.ok(
      !/\son[a-z]+\s*=/i.test(tag[0]),
      `an event-handler attribute reached the SVG: ${tag[0]}`,
    );
  }
  assert.ok(!/<foreignObject/i.test(svg), 'a <foreignObject> element reached the SVG');
  assert.ok(!svg.includes(']]>'), 'a literal `]]>` reached the SVG and can close a CDATA section');
  assert.equal(
    count(svg, /<text\b/g),
    count(svg, /<\/text>/g),
    'a label broke out of its <text> element',
  );
  // The escaped forms are what should be there instead.
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
});

test('security: quotes in a label cannot break out of an attribute', async () => {
  const svg = await renderSvg([
    'graph TD',
    '  A["it\'s a &quot;quoted&quot; label"] --> B[plain \'apostrophe\']',
    '  B -->|"a & b"| C',
    '',
  ].join('\n'));
  // Every attribute value in the document must still parse as a quoted string.
  for (const tag of svg.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const quotes = count(tag[0], /"/g);
    assert.equal(quotes % 2, 0, `unbalanced quotes in tag: ${tag[0]}`);
  }
  assert.ok(!/aria-label="[^"]*"[^">]*"/.test(svg), 'a quote escaped an attribute value');
});

test('security: sequence message and note text is escaped too', async () => {
  const svg = await renderSvg([
    'sequenceDiagram',
    '  participant A as <script>x</script>',
    '  A->>B: </text><script>alert(1)</script>',
    '  Note over A,B: ]]> & <b>bold</b>',
    '',
  ].join('\n'));
  assert.ok(!/<script/i.test(svg), 'a <script> tag reached the sequence SVG');
  assert.ok(!svg.includes(']]>'), 'a literal `]]>` reached the sequence SVG');
  assert.ok(!/<b>/.test(svg), 'raw HTML in a note reached the SVG');
  assert.equal(count(svg, /<text\b/g), count(svg, /<\/text>/g));
});

test('security: a node id cannot inject markup through a class or marker id', async () => {
  const out = await renderDiagram('graph TD\n  A --> B\n  class A "><script>alert(1)</script>\n');
  if (out.svg) {
    assert.ok(!/<script/i.test(out.svg), 'a class name injected markup');
    for (const tag of out.svg.matchAll(/<[a-zA-Z][^>]*>/g)) {
      assert.equal(count(tag[0], /"/g) % 2, 0, `unbalanced quotes in tag: ${tag[0]}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Diagnostics -- SPEC-MERMAID §3
// ---------------------------------------------------------------------------

/** The line a fence's first content line sits on, used to map diagnostics into the file. */
const FENCE_LINE = 10;

/**
 * Every diagnostic with `code`, rendered from `source` as if the fence body started at
 * file line {@link FENCE_LINE}.
 *
 * @param {string} source
 * @param {string} code
 * @returns {Promise<{hits: object[], out: object}>}
 */
async function diagnosticsFor(source, code) {
  const out = await renderDiagram(source, { line: FENCE_LINE });
  return { hits: out.diagnostics.filter((d) => d.code === code), out };
}

test('MD080: an unsupported diagram type is reported and renders as a code block', async () => {
  const { hits, out } = await diagnosticsFor('pie title Pets\n  "Dogs" : 386\n', 'MD080');
  assert.equal(hits.length, 1, 'MD080 must fire exactly once');
  assert.equal(hits[0].severity, 'info');
  assert.equal(hits[0].line, FENCE_LINE, 'MD080 points at the type line');
  assert.equal(out.svg, null, 'an unsupported type must fall back to a code block');

  // The type line is found after blanks and comments, and that is where the report lands.
  const offset = await diagnosticsFor('\n%% a comment\ngantt\n  title X\n', 'MD080');
  assert.equal(offset.hits.length, 1);
  assert.equal(offset.hits[0].line, FENCE_LINE + 2);
});

test('MD081: an unparseable line is an error that quotes what was expected', async () => {
  const { hits, out } = await diagnosticsFor('graph TD\n  A --> \n  B --> C\n', 'MD081');
  assert.ok(hits.length >= 1, 'a dangling arrow must report MD081');
  assert.equal(hits[0].severity, 'error');
  assert.equal(hits[0].line, FENCE_LINE + 1, 'MD081 points at the offending line');
  assert.match(
    `${hits[0].message} ${hits[0].hint || ''}`,
    /expect/i,
    'SPEC-MERMAID §3: MD081 must say what it expected',
  );
  assert.ok(out.diagnostics.some((d) => d.code === 'MD081'));
});

test('MD081: an unbalanced deactivate is an error at the offending line', async () => {
  const { hits } = await diagnosticsFor(
    'sequenceDiagram\n  participant A\n  deactivate A\n',
    'MD081',
  );
  assert.equal(hits.length, 1, 'deactivating a participant that is not active must report MD081');
  assert.equal(hits[0].line, FENCE_LINE + 2);
});

test('MD081: an activation that is never closed is reported too', async () => {
  const { hits } = await diagnosticsFor(
    'sequenceDiagram\n  participant A\n  participant B\n  activate A\n  A->>B: work\n',
    'MD081',
  );
  assert.ok(hits.length >= 1, 'a dangling `activate` must report MD081');
  assert.ok(
    hits[0].line >= FENCE_LINE && hits[0].line <= FENCE_LINE + 4,
    `MD081 landed on line ${hits[0].line}, outside the diagram`,
  );
});

test('MD082: an undeclared participant is auto-created with a warning', async () => {
  const { hits, out } = await diagnosticsFor(
    'sequenceDiagram\n  participant A\n  A->>B: hello\n',
    'MD082',
  );
  assert.equal(hits.length, 1, 'B is undeclared and must be reported once');
  assert.equal(hits[0].severity, 'warning');
  assert.equal(hits[0].line, FENCE_LINE + 2, 'MD082 points at the line that first used it');
  assert.ok(out.svg, 'the participant is auto-created, so the diagram still renders');
  assert.match(hits[0].message, /\bB\b/, 'the message should name the participant');
});

test('MD082 stays quiet when every participant is declared', async () => {
  const { hits } = await diagnosticsFor(
    'sequenceDiagram\n  participant A\n  participant B\n  A->>B: hello\n',
    'MD082',
  );
  assert.deepEqual(hits, []);
});

test('MD082 does not fire for ordinary flowchart nodes', async () => {
  // In a flowchart an edge *is* the declaration -- warning on `A --> B` would report every
  // diagram ever written, so MD082 belongs to the sequence path and to `class`/`subgraph`
  // statements that name a node which never appears.
  const { hits } = await diagnosticsFor('graph TD\n  A --> B\n  B --> C\n', 'MD082');
  assert.deepEqual(hits, []);
});

test('MD083: an %%{init}%% directive is parsed, reported and ignored', async () => {
  const source = '%%{init: {"theme": "forest"}}%%\ngraph TD\n  A --> B\n';
  const { hits, out } = await diagnosticsFor(source, 'MD083');
  assert.equal(hits.length, 1, 'the directive must be reported once');
  assert.equal(hits[0].severity, 'info');
  assert.equal(hits[0].line, FENCE_LINE, 'MD083 points at the directive');
  assert.equal(out.kind, 'flowchart', 'a leading directive must not confuse dispatch');
  assert.ok(out.svg, 'the diagram still renders');

  // Ignored means ignored: the directive must not change the output.
  const plain = await renderDiagram('graph TD\n  A --> B\n', { line: FENCE_LINE });
  assert.equal(out.svg, plain.svg, 'the directive was honoured instead of ignored');

  const inner = await diagnosticsFor('graph TD\n  %%{init: {"theme": "dark"}}%%\n  A --> B\n', 'MD083');
  assert.equal(inner.hits.length, 1);
  assert.equal(inner.hits[0].line, FENCE_LINE + 1);
});

test('MD084: each size limit is enforced, and the diagram is not rendered', async () => {
  /** SPEC-MERMAID §3: 300 nodes, 600 edges, 60 participants, 400 messages. */
  const oversized = {
    '301 nodes': () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 300; i += 1) lines.push(`  n${i} --> n${i + 1}`);
      return `${lines.join('\n')}\n`;
    },
    '601 edges': () => {
      const lines = ['graph TD'];
      for (let i = 0; i < 601; i += 1) lines.push('  A --> B');
      return `${lines.join('\n')}\n`;
    },
    '61 participants': () => {
      const lines = ['sequenceDiagram'];
      for (let i = 0; i < 61; i += 1) lines.push(`  participant p${i}`);
      lines.push('  p0->>p1: hi');
      return `${lines.join('\n')}\n`;
    },
    '401 messages': () => {
      const lines = ['sequenceDiagram', '  participant A', '  participant B'];
      for (let i = 0; i < 401; i += 1) lines.push(`  A->>B: m${i}`);
      return `${lines.join('\n')}\n`;
    },
  };

  for (const [what, build] of Object.entries(oversized)) {
    const source = build();
    const { hits, out } = await diagnosticsFor(source, 'MD084');
    assert.equal(hits.length, 1, `${what} must report MD084 exactly once`);
    assert.equal(hits[0].severity, 'warning', what);
    assert.equal(out.svg, null, `${what} must not be rendered`);
    // SPEC-MERMAID does not pin whether MD084 points at the diagram or at the statement
    // that crossed the line, only that it is inside the diagram.
    const lastLine = FENCE_LINE + source.split('\n').length - 1;
    assert.ok(
      hits[0].line >= FENCE_LINE && hits[0].line <= lastLine,
      `${what}: MD084 landed on line ${hits[0].line}, outside ${FENCE_LINE}..${lastLine}`,
    );
  }
});

test('a well-formed diagram produces no diagnostics at all', async () => {
  for (const fixture of [FLOW_FIXTURES[0], FLOW_FIXTURES[1], SEQUENCE_FIXTURES[1]]) {
    const out = await renderDiagram(fixture.source);
    assert.deepEqual(
      out.diagnostics.map((d) => `${d.code} ${d.message}`),
      [],
      `${fixture.name} should be clean`,
    );
  }
});

test('every mermaid diagnostic carries a file and a 1-based position', async () => {
  const { out } = await diagnosticsFor('sequenceDiagram\n  participant A\n  A->>B: hi\n', 'MD082');
  assert.ok(out.diagnostics.length > 0);
  for (const d of out.diagnostics) {
    assert.equal(d.file, 'test.md', 'the diagnostic must carry the file it came from');
    assert.ok(Number.isInteger(d.line) && d.line >= 1, `bad line: ${d.line}`);
    assert.ok(Number.isInteger(d.column) && d.column >= 1, `bad column: ${d.column}`);
    assert.equal(d.message, d.message.toLowerCase().slice(0, 1) + d.message.slice(1));
    assert.ok(!d.message.endsWith('.'), 'house style: the message is one lowercase line');
  }
});

// ---------------------------------------------------------------------------
// Renderer integration -- SPEC-MERMAID §9
// ---------------------------------------------------------------------------

test('integration: a mermaid fence becomes a figure.diagram in the document', async () => {
  const { html, codes } = await render(fence('graph TD\n  A[Start] --> B[Finish]'));
  assert.match(html, /<figure class="diagram diagram--flowchart"/);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="[^"]+"/);
  assert.match(html, /<svg class="diagram__svg"/);
  assert.ok(!html.includes('<figure class="code"'), 'the fence must not also emit a code block');
  assert.ok(!codes.includes('MD022'), `MD022 fired on a mermaid fence: ${codes.join(', ')}`);
});

test('integration: the `mmd` alias works and a sequence diagram gets its own modifier', async () => {
  const { html, codes } = await render(fence('sequenceDiagram\n  A->>B: hi', 'mmd'));
  assert.match(html, /<figure class="diagram diagram--sequence"/);
  assert.ok(!codes.includes('MD022'), `MD022 fired on an mmd fence: ${codes.join(', ')}`);
});

test('integration: an unsupported diagram type falls back to the code block path', async () => {
  const { html, codes } = await render(fence('pie title Pets\n  "Dogs" : 386'));
  assert.match(html, /<figure class="code"/, 'the fence must still render as code');
  assert.ok(!html.includes('class="diagram'), 'no diagram figure for an unsupported type');
  assert.ok(codes.includes('MD080'), `expected MD080, got ${codes.join(', ')}`);
});

test('integration: config.mermaid === false renders the fence as code', async () => {
  const config = testConfig({ mermaid: false });
  const { html } = await render(fence('graph TD\n  A --> B'), { config });
  assert.match(html, /<figure class="code"/);
  assert.ok(!html.includes('class="diagram'), 'diagrams must be off when config.mermaid is false');
});

test('integration: two diagrams on one page never collide on an id', async () => {
  const { html } = await render(
    `# Page\n\n${fence('graph TD\n  A --> B')}\n${fence('graph LR\n  C --> D')}\n`,
  );
  assert.equal(count(html, /<figure class="diagram/g), 2);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in the document: ${ids.join(', ')}`);
  assert.ok(ids.some((id) => id.startsWith('d1-')), 'the first diagram prefixes its ids with d1-');
  assert.ok(ids.some((id) => id.startsWith('d2-')), 'the second diagram prefixes its ids with d2-');
});

test('integration: an erroring diagram still leaves the page readable', async () => {
  const { html, codes } = await render(fence('graph TD\n  A --> '));
  assert.ok(codes.includes('MD081'), `expected MD081, got ${codes.join(', ')}`);
  assert.ok(
    /class="diagram/.test(html) || /<figure class="code"/.test(html),
    'a broken diagram must render as either a best-effort figure or a code block',
  );
});

test('integration: the stylesheet never overrides a label anchor the layout chose', async () => {
  // A CSS declaration beats an SVG presentation attribute. The renderers emit `text-anchor`
  // on every <text>, chosen from the geometry that positioned it -- `start` for a subgraph
  // title, an `else`/`and` divider caption and a self-message label, `middle` elsewhere. A
  // blanket `text-anchor: middle` in style.css silently re-anchors those three and pushes
  // them off the left of the viewBox, where they render clipped.
  const css = fs.readFileSync(path.join(REPO_ROOT, 'src/theme/style.css'), 'utf8');
  const declarations = [...css.matchAll(/^[^\S\n]*text-anchor[^\S\n]*:/gm)];
  assert.deepEqual(
    declarations.map((m) => css.slice(0, m.index).split('\n').length),
    [],
    'style.css declares text-anchor; the renderer owns anchoring, so this overrules the layout',
  );

  // ...and the renderer really does emit it every time, which is what makes that safe.
  const { html } = await render(
    `${fence('graph TD\n  subgraph Box\n    A --> B\n  end')}\n`
    + `${fence('sequenceDiagram\n  A->>A: loop back\n  alt one\n    A->>B: x\n  else two\n    B->>A: y\n  end')}\n`,
  );
  const texts = [...html.matchAll(/<text\b([^>]*)>/g)];
  assert.ok(texts.length > 0, 'the fixture produced no <text> at all');
  const anchorless = texts.filter((m) => !/\stext-anchor="/.test(m[1]));
  assert.deepEqual(anchorless.map((m) => m[0]), [], 'a <text> was emitted without text-anchor');
  assert.ok(
    texts.some((m) => /\stext-anchor="start"/.test(m[1])),
    'nothing anchored at `start`: the fixture should cover a subgraph title and an else divider',
  );
});

test('integration: no label escapes the viewBox its diagram declares', async () => {
  // The clipping bug this pins was invisible to every geometric assertion above, because the
  // layout's own numbers were right -- it was the *rendered* text that fell outside. Approximate
  // the browser with measureText(), which is the same estimate the layout was built on.
  const { measureText } = await loadSrc('markdown/mermaid/text.js');
  const { html } = await render(
    `${fence('graph TD\n  subgraph Outer\n    A[Alpha] --> B[Beta]\n  end\n  B --> C{Choose}')}\n`
    + `${fence('sequenceDiagram\n  participant A as Runner\n  A->>A: think about it\n'
      + '  alt happy path\n    A->>B: go\n  else the unhappy path\n    B->>A: stop\n  end')}\n`,
  );

  for (const figure of html.matchAll(/<figure class="diagram[\s\S]*?<\/figure>/g)) {
    const svg = svgElement(figure[0]);
    const [vx, vy, vw, vh] = (attrOf(svg, 'viewBox') || '').trim().split(/\s+/).map(Number);
    assert.ok([vx, vy, vw, vh].every(finite), `bad viewBox: ${attrOf(svg, 'viewBox')}`);

    for (const el of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const anchor = attrOf(`<x${el[1]}>`, 'text-anchor') || 'start';
      const x = Number(attrOf(`<x${el[1]}>`, 'x'));
      const lines = [...el[2].matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan>/g)]
        .map((m) => decodeEntities(m[1]));
      const width = Math.max(...lines.map((line) => measureText(line).width), 0);
      const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
      assert.ok(
        left >= vx - 1 && left + width <= vx + vw + 1,
        `label ${JSON.stringify(lines.join(' '))} spans ${left.toFixed(1)}..`
        + `${(left + width).toFixed(1)} outside viewBox ${vx}..${vx + vw}`,
      );
    }
  }
});

test('integration: the emitted document is byte-identical across two renders', async () => {
  const source = `# Diagrams\n\n${fence('graph TD\n  A --> B\n  A --> C')}\n${fence('sequenceDiagram\n  A->>B: hi')}\n`;
  const first = await render(source);
  const second = await render(source);
  assert.equal(second.html, first.html, 'the same document rendered differently twice');
});

// ---------------------------------------------------------------------------------------
// Regressions found by adversarial review after the first implementation pass.
// ---------------------------------------------------------------------------------------

test('edges crossing the same gutter get separate lanes, not one shared line', async () => {
  const { renderMermaid } = await import('../src/markdown/mermaid/index.js');

  // A-->D and B-->C both jog across the single gutter in opposite directions. Placing both
  // on the gutter midline painted them on top of each other: two edges, one visible line.
  const { svg } = renderMermaid('graph TD\n  A --> C\n  A --> D\n  B --> C\n  B --> D',
    { file: 't.md', line: 1, index: 1 });
  assert.ok(svg, 'diagram did not render');

  const paths = [...svg.matchAll(/<path class="dg-edge__line"([^>]*)>/g)]
    .map((m) => (/\sd="([^"]+)"/.exec(m[1]) || [])[1])
    .filter(Boolean);
  assert.equal(paths.length, 4);

  // The y of each edge's horizontal run, for the edges that actually jog.
  const runs = paths
    .map((d) => (/Q [\d.]+ ([\d.]+) /.exec(d) || [])[1])
    .filter(Boolean)
    .map(Number);

  assert.equal(runs.length, 2, 'expected two jogging edges');
  assert.notEqual(runs[0], runs[1],
    'both jogs share a horizontal run y, so they render as a single line');
});

test('a diagram too wide to scale legibly is marked for scrolling', async () => {
  const { renderHtml } = await import('../src/markdown/renderer.js');
  const { parseMarkdown } = await import('../src/markdown/parser.js');
  const { createSlugRegistry } = await import('../src/markdown/slug.js');

  const render = (body) => {
    const { ast } = parseMarkdown('```mermaid\n' + body + '\n```\n');
    return renderHtml(ast, {
      file: 't.md', config: { toc: { minDepth: 2, maxDepth: 3 } }, slugRegistry: createSlugRegistry(),
    }).html;
  };

  // Seven wide nodes in a row comfortably exceed the content column.
  const wide = render('graph LR\n  A[Ingest source files] --> B[Parse the Markdown] '
    + '--> C[Validate structure] --> D[Resolve links] --> E[Render HTML] '
    + '--> F[Verify output] --> G[Write dist]');
  const narrow = render('graph TD\n  A[Small] --> B[Also small]');

  const widthOf = (html) => Number((/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(html) || [])[1]);
  assert.ok(widthOf(wide) > 820, `expected a wide diagram, got ${widthOf(wide)}px`);
  assert.ok(widthOf(narrow) <= 820, `expected a narrow diagram, got ${widthOf(narrow)}px`);

  assert.match(wide, /<figure[^>]*data-wide="true"/,
    'wide diagram was not marked, so max-width:100% will scale it below legibility');
  assert.doesNotMatch(narrow, /data-wide/,
    'narrow diagram should scale to fit rather than scroll');
});
