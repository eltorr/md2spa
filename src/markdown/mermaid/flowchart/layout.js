/**
 * Flowchart layout -- a layered (Sugiyama) drawing engine.
 *
 * The whole point of building this instead of shipping mermaid.js is that the output has to
 * be *good*: evenly spaced, few crossings, long edges that read as straight lines rather than
 * staircases. Everything here therefore runs the full pipeline rather than a cheap
 * approximation:
 *
 *   cycles -> layers -> dummy nodes -> crossing reduction -> coordinates -> boxes -> routing
 *
 * Two rules shape every decision below.
 *
 *   *Determinism.* Same source, byte-identical SVG. Every collection is walked in insertion
 *   order, every sort has an explicit total-order tie-break, and no heuristic consults
 *   anything but the graph. Where a `Map` is iterated the order is its insertion order, which
 *   is the parse order, which is the source order.
 *
 *   *Termination.* A pathological diagram (K12, a 300-node chain, a graph that is one big
 *   cycle) is a build input like any other, so every loop is either a bounded `for` or carries
 *   an explicit pass counter. Nothing here can spin.
 *
 * Layout is always computed top-down internally. `LR`/`RL` swap each node's width and height
 * on the way in and transpose coordinates on the way out, which is what makes horizontal
 * layouts space themselves by the right axis instead of merely being rotated pictures.
 *
 * @module markdown/mermaid/flowchart/layout
 */

import { DEFAULT_FONT_SIZE, measureText, wrapText } from '../text.js';
import { shapeFit, shapeIntersectToward } from '../svg.js';

/** Minimum gap between one layer's band and the next, in px. */
export const LAYER_GAP = 56;

/** Minimum gap between two boxes sharing a layer, in px. */
export const NODE_GAP = 32;

/** Horizontal padding between a node's label and its outline, in px. */
export const NODE_PAD_X = 16;

/** Vertical padding between a node's label and its outline, in px. */
export const NODE_PAD_Y = 12;

/** Smallest width any node is allowed to have, in px. */
export const MIN_W = 48;

/** Smallest height any node is allowed to have, in px. */
export const MIN_H = 36;

/** Inset between a subgraph's frame and the content it encloses, in px. */
export const SUB_PAD = 20;

/** Left inset of a subgraph title. Must match `SUB_TITLE_INSET` in `../render/flowchart.js`. */
const SUB_TITLE_INSET = 12;

/** Padding around an edge label's background plate, in px. */
export const EDGE_LABEL_PAD = 6;

/** Corner radius the renderer should use when rounding edge polylines, in px. */
export const CORNER = 6;

/**
 * Slack added on top of every enforced gap.
 *
 * Coordinates are rounded for compact SVG output, and rounding two box edges independently
 * can shave a hair off a gap. Half a pixel of slack is invisible and keeps the "separation is
 * at least NODE_GAP" invariant true of the *rounded* numbers, which is what gets tested.
 */
const SEPARATION_EPS = 0.5;

/** Enforced centre-to-centre clearance within a layer. */
const MIN_SEP = NODE_GAP + SEPARATION_EPS;

// Work caps. These are deliberately generous for real documents and hard stops for the rest;
// exceeding one degrades layout quality, never correctness or termination.
const MAX_ORDER_SWEEPS = 12;
const MAX_TRANSPOSE_PASSES = 4;
const MAX_COORD_PASSES = 8;
const MAX_STRAIGHTEN_PASSES = 4;
const MAX_SUBGRAPH_PASSES = 4;
const MAX_DUMMY_NODES = 4000;
const MAX_WRAP_LINES = 200;

/** Above this many layered nodes the quadratic-ish refinements are skipped. */
const REFINEMENT_BUDGET = 900;

/** Default cap on a label's line length before it wraps, in px. */
const DEFAULT_LABEL_WIDTH = 220;

/**
 * @typedef {Object} PositionedNode
 * @property {string} id
 * @property {number} x centre
 * @property {number} y centre
 * @property {number} w
 * @property {number} h
 * @property {string} shape
 * @property {string[]} label wrapped lines
 * @property {string[]} classes
 */

/**
 * @typedef {Object} PositionedEdge
 * @property {{x: number, y: number}[]} points polyline, first/last on the shape outlines
 * @property {string} kind
 * @property {string[]|null} label wrapped lines
 * @property {{x: number, y: number}|null} labelPos
 * @property {number} labelWidth
 * @property {number} labelHeight
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} PositionedSubgraph
 * @property {string} id
 * @property {string} title
 * @property {number} x top-left
 * @property {number} y top-left
 * @property {number} w
 * @property {number} h
 * @property {number} depth 0 for a top-level subgraph
 * @property {number} titleHeight height of the title band inside the box, 0 when untitled
 */

/**
 * @typedef {Object} PositionedFlow
 * @property {number} width content box, before margin
 * @property {number} height content box, before margin
 * @property {PositionedNode[]} nodes
 * @property {PositionedEdge[]} edges
 * @property {PositionedSubgraph[]} subgraphs
 */

/**
 * Lay a parsed flowchart out.
 *
 * @param {import('./parse.js').FlowGraph|Object} graph
 * @param {{ fontSize?: number, edgeFontSize?: number, maxLabelWidth?: number,
 *           direction?: 'TD'|'TB'|'BT'|'LR'|'RL' }} [opts]
 * @returns {PositionedFlow}
 */
export function layoutFlowchart(graph, opts = {}) {
  const o = opts || {};
  // Must match text.js's DEFAULT_FONT_SIZE, which is what render/flowchart.js draws at and
  // what --dg-font-size (--fs-sm, 0.8125rem = 13px) paints. Measuring at 14 and drawing at 13
  // sized every box for text one point larger than it ever gets.
  const fontSize = numberOr(o.fontSize, DEFAULT_FONT_SIZE);
  const edgeFontSize = numberOr(o.edgeFontSize, 12);
  const maxLabelWidth = Math.max(80, numberOr(o.maxLabelWidth, DEFAULT_LABEL_WIDTH));
  const dir = normalizeDirection(o.direction || (graph && graph.direction));
  const transposed = dir === 'LR' || dir === 'RL';

  const nodes = buildNodes(graph, { fontSize, maxLabelWidth, transposed });
  if (nodes.length === 0) return { width: 0, height: 0, nodes: [], edges: [], subgraphs: [] };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = buildEdges(graph, byId, { edgeFontSize, maxLabelWidth, transposed });
  const subs = collectSubgraphs(graph, byId, fontSize);

  breakCycles(nodes, edges);
  assignLayers(nodes, edges);

  const dummies = insertDummies(nodes, edges, transposed);
  const all = nodes.concat(dummies);
  const layers = groupIntoLayers(all);
  linkAdjacency(all, edges);

  const pathOf = clusterPaths(subs, byId, dummies);
  orderLayers(layers, pathOf, all.length);
  assignX(layers, edges, all.length);

  const ranges = subgraphLayerRanges(subs, layers.length);
  assignY(layers, edges, subs, ranges, dir);

  let boxes = computeBoxes(subs, dir);
  boxes = resolveBoxCollisions(subs, boxes, layers, ranges, pathOf, dir);

  const routes = routeEdges(edges, layers);
  return toOutputSpace(nodes, edges, routes, subs, boxes, dir);
}

/* -------------------------------------------------------------------------- nodes & sizing */

/**
 * Wrap a node or edge label and measure the resulting block.
 * @param {string[]|string|null} label
 * @param {number} maxWidth
 * @param {number} size
 * @returns {{ lines: string[], w: number, h: number }}
 */
function measureBlock(label, maxWidth, size) {
  const source = Array.isArray(label) ? label : label == null ? [] : [String(label)];
  /** @type {string[]} */
  const lines = [];
  for (const raw of source) {
    if (lines.length >= MAX_WRAP_LINES) break;
    const piece = String(raw);
    if (piece === '') { lines.push(''); continue; }
    let wrapped;
    try {
      wrapped = wrapText(piece, maxWidth, { size });
    } catch {
      wrapped = [piece];
    }
    if (!Array.isArray(wrapped) || wrapped.length === 0) wrapped = [piece];
    for (const line of wrapped) {
      if (lines.length >= MAX_WRAP_LINES) break;
      lines.push(String(line));
    }
  }
  if (lines.length === 0) lines.push('');

  let w = 0;
  let lineH = size * 1.35;
  for (const line of lines) {
    const m = measureText(line, { size });
    if (m && Number.isFinite(m.width)) w = Math.max(w, m.width);
    if (m && Number.isFinite(m.height)) lineH = Math.max(lineH, m.height);
  }
  return { lines, w, h: lineH * lines.length };
}

/**
 * Grow a text block into a node box that actually contains it.
 *
 * The shape geometry lives in `svg.js`, which both draws the outline and answers "how big does
 * a {@link shapeFit|diamond} have to be to hold this rectangle" -- so the padding policy is the
 * only part that belongs here. Asking `svg.js` rather than reimplementing the trigonometry is
 * what stops a label poking through the border of the shape the renderer actually draws.
 *
 * @param {string} shape
 * @param {number} tw text width
 * @param {number} th text height
 * @returns {{ w: number, h: number }}
 */
function shapeSize(shape, tw, th) {
  return shapeFit(shape, tw + NODE_PAD_X * 2, th + NODE_PAD_Y * 2);
}

/**
 * @param {Object} graph
 * @param {{ fontSize: number, maxLabelWidth: number, transposed: boolean }} cfg
 * @returns {Object[]} internal node records in source order
 */
function buildNodes(graph, cfg) {
  const entries = graph && graph.nodes ? toEntries(graph.nodes) : [];
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const [id, raw] = entries[i];
    const shape = (raw && raw.shape) || 'rect';
    const block = measureBlock(raw && raw.label ? raw.label : [String(id)], cfg.maxLabelWidth, cfg.fontSize);
    const sized = shapeSize(shape, block.w, block.h);
    // Snap to a 2px grid so a 1.5px stroke centred on the border lands on whole pixels.
    const realW = snap2(Math.max(MIN_W, sized.w));
    const realH = snap2(Math.max(MIN_H, sized.h));
    out.push({
      id: String(id),
      index: i,
      dummy: false,
      shape,
      label: block.lines,
      classes: Array.isArray(raw && raw.classes) ? raw.classes.slice() : [],
      realW,
      realH,
      w: cfg.transposed ? realH : realW,
      h: cfg.transposed ? realW : realH,
      layer: 0,
      order: 0,
      x: 0,
      y: 0,
      preds: [],
      succs: [],
    });
  }
  return out;
}

/**
 * @param {Object} graph
 * @param {Map<string, Object>} byId
 * @param {{ edgeFontSize: number, maxLabelWidth: number, transposed: boolean }} cfg
 * @returns {Object[]} internal edge records in source order
 */
function buildEdges(graph, byId, cfg) {
  const list = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i] || {};
    const u = byId.get(String(raw.from));
    const v = byId.get(String(raw.to));
    // A dangling endpoint means the parser could not auto-create the node; drawing an edge to
    // nowhere is worse than dropping it.
    if (!u || !v) continue;
    const hasLabel = raw.label != null && (!Array.isArray(raw.label) || raw.label.length > 0);
    const block = hasLabel
      ? measureBlock(raw.label, cfg.maxLabelWidth, cfg.edgeFontSize)
      : null;
    out.push({
      index: i,
      from: u.id,
      to: v.id,
      u,
      v,
      kind: raw.kind || 'arrow',
      label: block ? block.lines : null,
      labelW: block ? block.w : 0,
      labelH: block ? block.h : 0,
      reversed: false,
      self: u === v,
      chain: [],
      labelDummy: null,
    });
  }
  return out;
}

/* --------------------------------------------------------------------------- subgraph tree */

/**
 * Flatten the subgraph forest into a pre-order list carrying depth, parent and the full set of
 * node keys underneath each entry.
 *
 * @param {Object} graph
 * @param {Map<string, Object>} byId
 * @param {number} fontSize
 * @returns {Object[]}
 */
function collectSubgraphs(graph, byId, fontSize) {
  const flat = [];
  const roots = Array.isArray(graph && graph.subgraphs) ? graph.subgraphs : [];
  let counter = 0;

  const walk = (list, parent, depth) => {
    if (depth > 32) return; // pathological nesting: stop rather than recurse forever
    for (const raw of list || []) {
      if (!raw) continue;
      const title = raw.title == null ? '' : String(raw.title);
      const measured = title ? measureText(title, { size: fontSize, weight: 'bold' }) : null;
      const titleH = measured && Number.isFinite(measured.height) ? measured.height : 0;
      const entry = {
        id: raw.id == null ? `sub${counter}` : String(raw.id),
        key: `sub#${counter}`,
        title,
        depth,
        parent,
        band: title ? titleH + 8 : 0,
        // The renderer draws the title left-anchored inside the frame, so the box has to be
        // wide enough to contain it. Only the height was kept before, and a title longer
        // than its members ran off the right of the box and out of the viewBox entirely.
        titleW: measured && Number.isFinite(measured.width) ? measured.width : 0,
        own: [],
        members: new Set(),
        children: [],
      };
      counter += 1;
      for (const nid of raw.nodeIds || []) {
        const n = byId.get(String(nid));
        if (n) entry.own.push(n);
      }
      flat.push(entry);
      if (parent) parent.children.push(entry);
      walk(raw.children, entry, depth + 1);
    }
  };
  walk(roots, null, 0);

  // Membership rolls up: a parent contains everything its descendants do.
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    const s = flat[i];
    for (const n of s.own) s.members.add(n);
    for (const c of s.children) for (const n of c.members) s.members.add(n);
  }
  return flat;
}

/**
 * Cluster path (root-to-leaf subgraph keys) for every node, used to keep a subgraph's members
 * contiguous inside each layer. A dummy inherits the deepest cluster shared by both endpoints
 * of its edge, so an edge that leaves a subgraph is not dragged back inside it.
 *
 * @param {Object[]} subs
 * @param {Map<string, Object>} byId
 * @param {Object[]} dummies
 * @returns {Map<Object, string[]>}
 */
function clusterPaths(subs, byId, dummies) {
  /** @type {Map<Object, string[]>} */
  const paths = new Map();
  for (const n of byId.values()) paths.set(n, []);
  // Deepest wins: walking the pre-order list forward means a child overwrites its parent.
  for (const s of subs) {
    const chain = [];
    for (let p = s; p; p = p.parent) chain.unshift(p.key);
    for (const n of s.own) paths.set(n, chain);
  }
  for (const d of dummies) {
    const a = paths.get(d.edge.u) || [];
    const b = paths.get(d.edge.v) || [];
    const shared = [];
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) break;
      shared.push(a[i]);
    }
    paths.set(d, shared);
  }
  return paths;
}

/* ------------------------------------------------------------------- cycles & layering */

/**
 * Reverse back edges so the rest of the pipeline sees a DAG. The reversal is remembered and
 * undone when the polyline is emitted, so a cycle still draws with its arrows the right way
 * round.
 *
 * Iterative DFS: a 300-node cycle must not blow the stack.
 *
 * @param {Object[]} nodes
 * @param {Object[]} edges
 */
function breakCycles(nodes, edges) {
  /** @type {Map<Object, Object[]>} */
  const out = new Map();
  for (const n of nodes) out.set(n, []);
  for (const e of edges) if (!e.self) out.get(e.u).push(e);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const state = new Map(nodes.map((n) => [n, WHITE]));

  for (const root of nodes) {
    if (state.get(root) !== WHITE) continue;
    /** @type {Array<{ node: Object, i: number }>} */
    const stack = [{ node: root, i: 0 }];
    state.set(root, GRAY);
    let guard = 0;
    const limit = (nodes.length + edges.length) * 4 + 16;
    while (stack.length > 0) {
      guard += 1;
      if (guard > limit) break; // cannot happen; the cap is the promise that it cannot hang
      const frame = stack[stack.length - 1];
      const list = out.get(frame.node);
      if (frame.i >= list.length) {
        state.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const e = list[frame.i];
      frame.i += 1;
      const next = e.v;
      const s = state.get(next);
      if (s === GRAY) {
        e.reversed = true;
        const tmp = e.u;
        e.u = e.v;
        e.v = tmp;
      } else if (s === WHITE) {
        state.set(next, GRAY);
        stack.push({ node: next, i: 0 });
      }
    }
  }
}

/**
 * Longest-path layering, then a tightening pass that pulls every non-sink down to just above
 * its highest-placed successor. Without the tightening a graph with one long branch leaves the
 * short branches marooned at the top and the drawing reads as a staircase.
 *
 * @param {Object[]} nodes
 * @param {Object[]} edges
 */
function assignLayers(nodes, edges) {
  const succ = new Map(nodes.map((n) => [n, []]));
  const pred = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (e.self) continue;
    succ.get(e.u).push(e.v);
    pred.get(e.v).push(e.u);
  }

  const indeg = new Map(nodes.map((n) => [n, pred.get(n).length]));
  const topo = [];
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  for (let head = 0; head < queue.length; head += 1) {
    const n = queue[head];
    topo.push(n);
    for (const m of succ.get(n)) {
      const d = indeg.get(m) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  // Cycle breaking guarantees a DAG; if a residue survives, layer it after everything else
  // rather than dropping it.
  if (topo.length < nodes.length) {
    const seen = new Set(topo);
    for (const n of nodes) if (!seen.has(n)) topo.push(n);
  }

  for (const n of nodes) n.layer = 0;
  for (const n of topo) {
    for (const m of succ.get(n)) {
      if (m.layer < n.layer + 1) m.layer = n.layer + 1;
    }
  }

  for (let i = topo.length - 1; i >= 0; i -= 1) {
    const n = topo[i];
    const ss = succ.get(n);
    if (ss.length === 0) continue;
    let lowest = Infinity;
    for (const m of ss) lowest = Math.min(lowest, m.layer);
    if (Number.isFinite(lowest) && lowest - 1 > n.layer) n.layer = lowest - 1;
  }

  let min = Infinity;
  for (const n of nodes) min = Math.min(min, n.layer);
  if (Number.isFinite(min) && min !== 0) for (const n of nodes) n.layer -= min;
}

/* ---------------------------------------------------------------------------- dummy chains */

/**
 * Give every edge that spans more than one layer a real node on each layer it crosses, so it
 * routes *through* the drawing instead of over it, and so crossing reduction can see it.
 *
 * The middle dummy of a labelled chain is inflated to the label's size, which reserves the
 * space the label plate will occupy.
 *
 * @param {Object[]} nodes
 * @param {Object[]} edges
 * @param {boolean} transposed
 * @returns {Object[]} the dummies, in creation order
 */
function insertDummies(nodes, edges, transposed) {
  const dummies = [];
  let created = 0;
  for (const e of edges) {
    e.chain = [];
    if (e.self) continue;
    const span = e.v.layer - e.u.layer;
    if (span <= 1) continue;
    if (created + span - 1 > MAX_DUMMY_NODES) continue; // degrade to a straight line
    for (let layer = e.u.layer + 1; layer < e.v.layer; layer += 1) {
      const d = {
        id: `\u0000dummy${created}`,
        index: nodes.length + created,
        dummy: true,
        edge: e,
        shape: 'rect',
        label: [],
        classes: [],
        realW: 1,
        realH: 1,
        w: 1,
        h: 1,
        layer,
        order: 0,
        x: 0,
        y: 0,
        preds: [],
        succs: [],
      };
      created += 1;
      e.chain.push(d);
      dummies.push(d);
    }
    if (e.label && e.chain.length > 0) {
      const mid = e.chain[Math.floor((e.chain.length - 1) / 2)];
      const lw = e.labelW + EDGE_LABEL_PAD * 2;
      const lh = e.labelH + EDGE_LABEL_PAD * 2;
      mid.w = transposed ? lh : lw;
      mid.h = transposed ? lw : lh;
      e.labelDummy = mid;
    }
  }
  return dummies;
}

/**
 * @param {Object[]} all real nodes followed by dummies
 * @returns {Object[][]} layers, each ordered by insertion index for now
 */
function groupIntoLayers(all) {
  let max = 0;
  for (const n of all) max = Math.max(max, n.layer);
  const layers = [];
  for (let i = 0; i <= max; i += 1) layers.push([]);
  for (const n of all) layers[n.layer].push(n);
  for (const layer of layers) layer.sort((a, b) => a.index - b.index);
  return layers;
}

/**
 * Turn each edge into a chain of unit-length segments and record them as adjacency on the
 * nodes. Self loops take part in nothing.
 *
 * @param {Object[]} all
 * @param {Object[]} edges
 */
function linkAdjacency(all, edges) {
  for (const n of all) {
    n.preds = [];
    n.succs = [];
  }
  for (const e of edges) {
    if (e.self) continue;
    let prev = e.u;
    for (const d of e.chain) {
      prev.succs.push(d);
      d.preds.push(prev);
      prev = d;
    }
    prev.succs.push(e.v);
    e.v.preds.push(prev);
  }
}

/* ----------------------------------------------------------------------- crossing reduction */

/**
 * Order the nodes inside each layer.
 *
 * Alternating median sweeps with an adjacent-swap (transpose) refinement, scoring the whole
 * drawing after every sweep and keeping the best ordering seen. Ties break on insertion index,
 * which is source order, which is what makes the result reproducible.
 *
 * @param {Object[][]} layers
 * @param {Map<Object, string[]>} pathOf
 * @param {number} size total node count, used to scale the effort
 */
function orderLayers(layers, pathOf, size) {
  if (layers.length === 0) return;
  seedOrder(layers);
  for (const layer of layers) reindex(layer);

  const heavy = size > REFINEMENT_BUDGET;
  const sweeps = heavy ? 4 : MAX_ORDER_SWEEPS;

  for (let i = 0; i < layers.length; i += 1) {
    layers[i] = enforceClusters(layers[i], pathOf);
    reindex(layers[i]);
  }
  let best = snapshotOrder(layers);
  let bestScore = countCrossings(layers);

  for (let sweep = 0; sweep < sweeps && bestScore > 0; sweep += 1) {
    medianSweep(layers, sweep % 2 === 0);
    if (!heavy) transposeSweep(layers);
    for (let i = 0; i < layers.length; i += 1) {
      layers[i] = enforceClusters(layers[i], pathOf);
      reindex(layers[i]);
    }
    const score = countCrossings(layers);
    if (score < bestScore) {
      bestScore = score;
      best = snapshotOrder(layers);
    }
  }

  restoreOrder(layers, best);
  for (let i = 0; i < layers.length; i += 1) {
    layers[i] = enforceClusters(layers[i], pathOf);
    reindex(layers[i]);
  }
}

/**
 * Greedy first ordering: walk down the layers placing each node at the average position of the
 * predecessors already placed above it. A good seed means the sweeps have less to undo.
 * @param {Object[][]} layers
 */
function seedOrder(layers) {
  for (let li = 1; li < layers.length; li += 1) {
    const above = new Map();
    layers[li - 1].forEach((n, i) => above.set(n, i));
    const keyed = layers[li].map((n, i) => {
      let sum = 0;
      let count = 0;
      for (const p of n.preds) {
        const pos = above.get(p);
        if (pos !== undefined) { sum += pos; count += 1; }
      }
      return { n, i, key: count > 0 ? sum / count : Infinity };
    });
    keyed.sort((a, b) => (a.key - b.key) || (a.n.index - b.n.index) || (a.i - b.i));
    layers[li] = keyed.map((k) => k.n);
  }
}

/**
 * @param {Object[]} layer
 */
function reindex(layer) {
  for (let i = 0; i < layer.length; i += 1) layer[i].order = i;
}

/**
 * @param {Object[][]} layers
 * @returns {Object[][]}
 */
function snapshotOrder(layers) {
  return layers.map((layer) => layer.slice());
}

/**
 * @param {Object[][]} layers
 * @param {Object[][]} snapshot
 */
function restoreOrder(layers, snapshot) {
  for (let i = 0; i < layers.length; i += 1) layers[i] = snapshot[i].slice();
}

/**
 * One median/barycenter pass. Nodes with no neighbours in the reference layer keep their slot,
 * which is the standard way to stop isolated nodes from drifting to the left edge.
 *
 * @param {Object[][]} layers
 * @param {boolean} down true to order each layer against the one above it
 */
function medianSweep(layers, down) {
  const start = down ? 1 : layers.length - 2;
  const step = down ? 1 : -1;
  for (let li = start; li >= 0 && li < layers.length; li += step) {
    const ref = new Map();
    layers[li + (down ? -1 : 1)].forEach((n, i) => ref.set(n, i));
    const keyed = layers[li].map((n, i) => {
      const positions = [];
      for (const m of down ? n.preds : n.succs) {
        const pos = ref.get(m);
        if (pos !== undefined) positions.push(pos);
      }
      return { n, i, key: median(positions) };
    });
    // -1 marks "no opinion": those entries keep their current index as the sort key.
    for (const k of keyed) if (k.key < 0) k.key = k.i;
    keyed.sort((a, b) => (a.key - b.key) || (a.i - b.i));
    layers[li] = keyed.map((k) => k.n);
    reindex(layers[li]);
  }
}

/**
 * @param {number[]} values
 * @returns {number} -1 when empty
 */
function median(values) {
  if (values.length === 0) return -1;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Adjacent-swap refinement: swap neighbouring nodes whenever it strictly reduces the crossings
 * they are involved in. Strictness is what keeps this from oscillating.
 * @param {Object[][]} layers
 */
function transposeSweep(layers) {
  for (let pass = 0; pass < MAX_TRANSPOSE_PASSES; pass += 1) {
    let improved = false;
    for (let li = 0; li < layers.length; li += 1) {
      const layer = layers[li];
      const up = li > 0 ? positionMap(layers[li - 1]) : null;
      const down = li + 1 < layers.length ? positionMap(layers[li + 1]) : null;
      for (let i = 0; i + 1 < layer.length; i += 1) {
        const a = layer[i];
        const b = layer[i + 1];
        const before = pairCrossings(a, b, up, down);
        const after = pairCrossings(b, a, up, down);
        if (after < before) {
          layer[i] = b;
          layer[i + 1] = a;
          improved = true;
        }
      }
      reindex(layer);
    }
    if (!improved) break;
  }
}

/**
 * @param {Object[]} layer
 * @returns {Map<Object, number>}
 */
function positionMap(layer) {
  const map = new Map();
  layer.forEach((n, i) => map.set(n, i));
  return map;
}

/**
 * Crossings contributed by the edges of `a` and `b` when `a` sits immediately left of `b`.
 * @param {Object} a
 * @param {Object} b
 * @param {Map<Object, number>|null} up
 * @param {Map<Object, number>|null} down
 * @returns {number}
 */
function pairCrossings(a, b, up, down) {
  let count = 0;
  if (up) count += inversions(neighbourPositions(a.preds, up), neighbourPositions(b.preds, up));
  if (down) count += inversions(neighbourPositions(a.succs, down), neighbourPositions(b.succs, down));
  return count;
}

/**
 * @param {Object[]} list
 * @param {Map<Object, number>} pos
 * @returns {number[]}
 */
function neighbourPositions(list, pos) {
  const out = [];
  for (const n of list) {
    const p = pos.get(n);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} pairs where the left node's endpoint sits right of the right node's
 */
function inversions(left, right) {
  let count = 0;
  for (const p of left) for (const q of right) if (p > q) count += 1;
  return count;
}

/**
 * Total edge crossings across every layer boundary, counted by inversion count over a Fenwick
 * tree so a dense graph stays near-linear instead of quadratic.
 * @param {Object[][]} layers
 * @returns {number}
 */
function countCrossings(layers) {
  let total = 0;
  for (let li = 0; li + 1 < layers.length; li += 1) {
    const lower = positionMap(layers[li + 1]);
    /** @type {number[][]} */
    const pairs = [];
    layers[li].forEach((n, i) => {
      for (const m of n.succs) {
        const p = lower.get(m);
        if (p !== undefined) pairs.push([i, p]);
      }
    });
    if (pairs.length < 2) continue;
    pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const n = layers[li + 1].length;
    const tree = new Int32Array(n + 1);
    for (let k = pairs.length - 1; k >= 0; k -= 1) {
      const j = pairs[k][1];
      for (let x = j; x > 0; x -= x & -x) total += tree[x];
      for (let x = j + 1; x <= n; x += x & -x) tree[x] += 1;
    }
  }
  return total;
}

/**
 * Reorder a layer so that every subgraph's members form one contiguous run, recursively by
 * nesting depth. Groups keep their relative order by mean position, so this nudges the
 * ordering rather than rewriting it.
 *
 * @param {Object[]} layer
 * @param {Map<Object, string[]>} pathOf
 * @returns {Object[]}
 */
function enforceClusters(layer, pathOf) {
  if (layer.length < 2) return layer;
  return groupAtDepth(layer.map((n, i) => ({ n, pos: i })), 0, pathOf).map((it) => it.n);
}

/**
 * @param {Array<{n: Object, pos: number}>} items
 * @param {number} depth
 * @param {Map<Object, string[]>} pathOf
 * @returns {Array<{n: Object, pos: number}>}
 */
function groupAtDepth(items, depth, pathOf) {
  if (items.length < 2 || depth > 32) return items;
  /** @type {Array<{key: string|null, items: Array<{n: Object, pos: number}>, sum: number, first: number}>} */
  const groups = [];
  const index = new Map();
  let clustered = false;
  for (const it of items) {
    const path = pathOf.get(it.n);
    const key = path && depth < path.length ? path[depth] : null;
    if (key === null) {
      groups.push({ key: null, items: [it], sum: it.pos, first: it.pos });
      continue;
    }
    clustered = true;
    let g = index.get(key);
    if (!g) {
      g = { key, items: [], sum: 0, first: it.pos };
      index.set(key, g);
      groups.push(g);
    }
    g.items.push(it);
    g.sum += it.pos;
  }
  if (!clustered) return items;

  groups.sort((a, b) => ((a.sum / a.items.length) - (b.sum / b.items.length)) || (a.first - b.first));
  const out = [];
  for (const g of groups) {
    const inner = g.key === null ? g.items : groupAtDepth(g.items, depth + 1, pathOf);
    for (const it of inner) out.push(it);
  }
  return out;
}

/* -------------------------------------------------------------------- coordinate assignment */

/**
 * Horizontal coordinates by the priority method.
 *
 * Each node wants to sit at the median of its neighbours in the reference layer, and may only
 * displace neighbours of strictly lower priority. Dummies get infinite priority, which is the
 * whole trick behind straight long edges: a chain of dummies outranks everything and drags
 * itself into a line.
 *
 * @param {Object[][]} layers
 * @param {Object[]} edges
 * @param {number} size
 */
function assignX(layers, edges, size) {
  for (const layer of layers) packLayer(layer);

  const passes = size > REFINEMENT_BUDGET ? 4 : MAX_COORD_PASSES;
  for (let pass = 0; pass < passes; pass += 1) {
    const down = pass % 2 === 0;
    const start = down ? 1 : layers.length - 2;
    const step = down ? 1 : -1;
    for (let li = start; li >= 0 && li < layers.length; li += step) {
      priorityPass(layers[li], down);
    }
  }
  straightenChains(layers, edges);

  let min = Infinity;
  for (const layer of layers) for (const n of layer) min = Math.min(min, n.x - n.w / 2);
  if (Number.isFinite(min)) for (const layer of layers) for (const n of layer) n.x -= min;
}

/**
 * Pack a layer left to right and centre it on the origin, so the first median pass starts from
 * a balanced picture rather than everything hugging the left edge.
 * @param {Object[]} layer
 */
function packLayer(layer) {
  let cursor = 0;
  for (const n of layer) {
    n.x = cursor + n.w / 2;
    cursor += n.w + MIN_SEP;
  }
  const width = cursor - (layer.length > 0 ? MIN_SEP : 0);
  const shift = width / 2;
  for (const n of layer) n.x -= shift;
}

/**
 * @param {Object[]} layer
 * @param {boolean} down reference the layer above (true) or below (false)
 */
function priorityPass(layer, down) {
  if (layer.length === 0) return;
  const prio = layer.map((n) => (n.dummy ? Infinity : (down ? n.preds.length : n.succs.length)));
  const target = layer.map((n) => {
    const xs = [];
    for (const m of down ? n.preds : n.succs) xs.push(m.x);
    return xs.length === 0 ? null : median(xs);
  });
  const order = layer.map((n, i) => i);
  order.sort((a, b) => {
    if (prio[a] !== prio[b]) return prio[a] > prio[b] ? -1 : 1;
    return layer[a].index - layer[b].index;
  });
  const prioOf = (n) => prio[n.order];
  for (const i of order) {
    if (target[i] === null) continue;
    moveNode(layer, i, target[i] - layer[i].x, prioOf);
  }
}

/**
 * Pull every chain of dummies onto one x, subject to the same separation rules. The priority
 * pass gets most of the way there; this closes the last pixel or two so a five-layer edge is
 * a single straight line.
 *
 * @param {Object[][]} layers
 * @param {Object[]} edges
 */
function straightenChains(layers, edges) {
  const chains = edges.filter((e) => e.chain.length > 1);
  if (chains.length === 0) return;
  const prioOf = (n) => (n.dummy ? Infinity : n.preds.length + n.succs.length);
  for (let pass = 0; pass < MAX_STRAIGHTEN_PASSES; pass += 1) {
    let moved = 0;
    for (const e of chains) {
      const goal = median(e.chain.map((d) => d.x));
      for (const d of e.chain) {
        const layer = layers[d.layer];
        const delta = goal - d.x;
        if (Math.abs(delta) < 0.05) continue;
        moved += Math.abs(moveNode(layer, d.order, delta, prioOf));
      }
    }
    if (moved < 0.5) break;
  }
}

/**
 * Move one node inside its layer, cascading the displacement into whatever it pushes.
 * @param {Object[]} layer
 * @param {number} i
 * @param {number} dx
 * @param {(n: Object) => number} prioOf
 * @returns {number} the distance actually travelled
 */
function moveNode(layer, i, dx, prioOf) {
  if (!(Math.abs(dx) > 0.01)) return 0;
  const capacity = dx > 0 ? capacityRight(layer, i, prioOf) : capacityLeft(layer, i, prioOf);
  const travel = Math.sign(dx) * Math.min(Math.abs(dx), capacity);
  if (!(Math.abs(travel) > 0.01)) return 0;
  layer[i].x += travel;
  if (travel > 0) cascadeRight(layer, i);
  else cascadeLeft(layer, i);
  return travel;
}

/**
 * @param {Object} a
 * @param {Object} b
 * @returns {number} slack between two adjacent boxes, never negative
 */
function slack(a, b) {
  return Math.max(0, (b.x - b.w / 2) - (a.x + a.w / 2) - MIN_SEP);
}

/**
 * @param {Object[]} layer
 * @param {number} i
 * @param {(n: Object) => number} prioOf
 * @returns {number}
 */
function capacityRight(layer, i, prioOf) {
  const p = prioOf(layer[i]);
  let cap = 0;
  for (let j = i; j + 1 < layer.length; j += 1) {
    cap += slack(layer[j], layer[j + 1]);
    if (prioOf(layer[j + 1]) >= p) return cap;
  }
  return Infinity;
}

/**
 * @param {Object[]} layer
 * @param {number} i
 * @param {(n: Object) => number} prioOf
 * @returns {number}
 */
function capacityLeft(layer, i, prioOf) {
  const p = prioOf(layer[i]);
  let cap = 0;
  for (let j = i; j - 1 >= 0; j -= 1) {
    cap += slack(layer[j - 1], layer[j]);
    if (prioOf(layer[j - 1]) >= p) return cap;
  }
  return Infinity;
}

/**
 * @param {Object[]} layer
 * @param {number} i
 */
function cascadeRight(layer, i) {
  for (let j = i; j + 1 < layer.length; j += 1) {
    const need = (layer[j].x + layer[j].w / 2 + MIN_SEP) - (layer[j + 1].x - layer[j + 1].w / 2);
    if (need <= 0) break;
    layer[j + 1].x += need;
  }
}

/**
 * @param {Object[]} layer
 * @param {number} i
 */
function cascadeLeft(layer, i) {
  for (let j = i; j - 1 >= 0; j -= 1) {
    const need = (layer[j - 1].x + layer[j - 1].w / 2 + MIN_SEP) - (layer[j].x - layer[j].w / 2);
    if (need <= 0) break;
    layer[j - 1].x -= need;
  }
}

/* --------------------------------------------------------------------------- vertical bands */

/**
 * Which layers a subgraph spans. Boxes are drawn from coordinates, but the *space* they need
 * has to be booked before the layers are placed.
 *
 * @param {Object[]} subs
 * @param {number} layerCount
 * @returns {Map<Object, {top: number, bottom: number}>}
 */
function subgraphLayerRanges(subs, layerCount) {
  const ranges = new Map();
  for (const s of subs) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const n of s.members) {
      top = Math.min(top, n.layer);
      bottom = Math.max(bottom, n.layer);
    }
    if (!Number.isFinite(top)) continue;
    ranges.set(s, { top, bottom: Math.min(bottom, layerCount - 1) });
  }
  return ranges;
}

/**
 * Place each layer's centreline, booking extra room where a subgraph frame, its title band or
 * an edge label has to fit between two layers.
 *
 * @param {Object[][]} layers
 * @param {Object[]} edges
 * @param {Object[]} subs
 * @param {Map<Object, {top: number, bottom: number}>} ranges
 * @param {'TD'|'BT'|'LR'|'RL'} dir
 */
function assignY(layers, edges, subs, ranges, dir) {
  const count = layers.length;
  const above = new Float64Array(count);
  const below = new Float64Array(count);
  const titleSide = bandSide(dir);
  for (const s of subs) {
    const r = ranges.get(s);
    if (!r) continue;
    above[r.top] += SUB_PAD + (titleSide === 'top' ? s.band : 0);
    below[r.bottom] += SUB_PAD + (titleSide === 'bottom' ? s.band : 0);
  }

  // A label on an edge between adjacent layers has nowhere to hide, so widen that gap.
  const labelGap = new Float64Array(Math.max(1, count));
  const transposed = dir === 'LR' || dir === 'RL';
  for (const e of edges) {
    if (e.self || !e.label) continue;
    if (e.v.layer - e.u.layer !== 1) continue;
    const need = (transposed ? e.labelW : e.labelH) + EDGE_LABEL_PAD * 2;
    labelGap[e.u.layer] = Math.max(labelGap[e.u.layer], need);
  }

  let top = 0;
  for (let li = 0; li < count; li += 1) {
    let bandH = 0;
    for (const n of layers[li]) bandH = Math.max(bandH, n.h);
    const centre = top + bandH / 2 + above[li];
    for (const n of layers[li]) n.y = centre;
    top += above[li] + bandH + below[li];
    if (li + 1 < count) top += LAYER_GAP + SEPARATION_EPS + labelGap[li];
  }
}

/**
 * Which side of the *internal* box the title band is reserved on, chosen so that after the
 * final transform the band always ends up at the visual top.
 * @param {'TD'|'BT'|'LR'|'RL'} dir
 * @returns {'top'|'bottom'|'left'}
 */
function bandSide(dir) {
  if (dir === 'BT') return 'bottom';
  if (dir === 'LR' || dir === 'RL') return 'left';
  return 'top';
}

/* ------------------------------------------------------------------------- subgraph boxes */

/**
 * Box every subgraph around its members and its child boxes. Computed innermost-first so a
 * parent always encloses its children with a full `SUB_PAD` to spare.
 *
 * @param {Object[]} subs pre-order
 * @param {'TD'|'BT'|'LR'|'RL'} dir
 * @returns {Map<Object, {x0: number, y0: number, x1: number, y1: number}>}
 */
function computeBoxes(subs, dir) {
  const side = bandSide(dir);
  /** @type {Map<Object, {x0: number, y0: number, x1: number, y1: number}>} */
  const boxes = new Map();
  for (let i = subs.length - 1; i >= 0; i -= 1) {
    const s = subs[i];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of s.own) {
      x0 = Math.min(x0, n.x - n.w / 2);
      x1 = Math.max(x1, n.x + n.w / 2);
      y0 = Math.min(y0, n.y - n.h / 2);
      y1 = Math.max(y1, n.y + n.h / 2);
    }
    for (const c of s.children) {
      const b = boxes.get(c);
      if (!b) continue;
      x0 = Math.min(x0, b.x0);
      x1 = Math.max(x1, b.x1);
      y0 = Math.min(y0, b.y0);
      y1 = Math.max(y1, b.y1);
    }
    if (!Number.isFinite(x0)) continue;
    const box = {
      x0: x0 - SUB_PAD - (side === 'left' ? s.band : 0),
      x1: x1 + SUB_PAD,
      y0: y0 - SUB_PAD - (side === 'top' ? s.band : 0),
      y1: y1 + SUB_PAD + (side === 'bottom' ? s.band : 0),
    };
    // Grow rightwards to fit the title. It is anchored at the left inset, so the space it
    // needs is that inset on both sides plus the measured text.
    const needed = SUB_TITLE_INSET * 2 + (s.titleW || 0);
    if (box.x1 - box.x0 < needed) box.x1 = box.x0 + needed;
    boxes.set(s, box);
  }
  return boxes;
}

/**
 * Push non-members out of the way of a subgraph frame.
 *
 * Cluster contiguity already keeps members together inside each layer, so the only thing that
 * can intrude is a neighbour whose box laps over the frame. Shift it (and everything behind
 * it) far enough out, then re-box and check again; four passes is plenty for real diagrams and
 * a hard stop for the rest.
 *
 * @param {Object[]} subs
 * @param {Map<Object, Object>} boxes
 * @param {Object[][]} layers
 * @param {Map<Object, {top: number, bottom: number}>} ranges
 * @param {Map<Object, string[]>} pathOf
 * @param {'TD'|'BT'|'LR'|'RL'} dir
 * @returns {Map<Object, Object>}
 */
function resolveBoxCollisions(subs, boxes, layers, ranges, pathOf, dir) {
  if (subs.length === 0) return boxes;
  const clearance = NODE_GAP / 2;
  let current = boxes;
  for (let pass = 0; pass < MAX_SUBGRAPH_PASSES; pass += 1) {
    let moved = false;
    for (const s of subs) {
      const box = current.get(s);
      const range = ranges.get(s);
      if (!box || !range) continue;
      for (let li = range.top; li <= range.bottom; li += 1) {
        const layer = layers[li];
        for (let i = 0; i < layer.length; i += 1) {
          const n = layer[i];
          // Members belong inside, and so does a dummy routing an edge that never leaves the
          // subgraph -- evicting those would tear the frame away from its own contents.
          if (s.members.has(n)) continue;
          const path = pathOf.get(n);
          if (path && path.indexOf(s.key) !== -1) continue;
          const left = n.x - n.w / 2;
          const right = n.x + n.w / 2;
          if (right <= box.x0 - clearance || left >= box.x1 + clearance) continue;
          // Push towards whichever side it is already nearer; that keeps the ordering.
          if (n.x < (box.x0 + box.x1) / 2) {
            const need = right - (box.x0 - clearance);
            n.x -= need;
            cascadeLeft(layer, i);
          } else {
            const need = (box.x1 + clearance) - left;
            n.x += need;
            cascadeRight(layer, i);
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
    current = computeBoxes(subs, dir);
  }
  return current;
}

/* -------------------------------------------------------------------------- edge routing */

/**
 * Build each edge's polyline through its dummies, in internal coordinates.
 *
 * A segment whose endpoints differ on both axes gets two waypoints on the halfway line of the
 * *gutter between the two layer bands*, which is what turns a diagonal into the
 * orthogonal-with-rounded-corners look. Halfway between the two centres is the tempting
 * simplification and it is wrong: a tall node beside a short one puts that point inside the
 * tall one, and the edge then appears to leave through the node's own middle.
 *
 * Halfway between the two nodes' own edges is wrong for the same reason, one step removed: a
 * node much shorter than its layer's tallest member has its own trailing edge well inside the
 * band, so the midpoint between it and the next layer can still land level with a taller
 * sibling -- and the jog then runs straight through that sibling's box. Measuring the gutter
 * between the *bands* fixes that: nothing is placed there by construction, so both waypoints
 * are always in open space.
 *
 * Collinear points are dropped afterwards so a straight chain stays a straight chain.
 *
 * @param {Object[]} edges
 * @param {Object[][]} layers
 * @returns {Map<Object, {points: Array<{x: number, y: number}>, labelPoint: {x: number, y: number}|null}>}
 */
/**
 * Stable identity for one jogging segment of an edge: the edge plus which hop it is.
 * @param {Object} edge
 * @param {number} segIndex
 * @returns {string}
 */
function jogKey(edge, segIndex) {
  return `${edge.index}:${segIndex}`;
}

/**
 * Give every jog crossing the same gutter its own horizontal lane.
 *
 * Each jog needs a y inside the gutter to turn its diagonal into two right angles. Putting
 * them all on the gutter's midline is the obvious choice and it collapses information: in
 * `A-->C, A-->D, B-->C, B-->D` the A->D and B->C runs occupy the same y over the same x
 * range in opposite directions, so they paint exactly on top of each other and the reader
 * sees one line where there are two.
 *
 * Lanes are ordered by horizontal span -- widest first, so long runs sit nearest the layer
 * they came from and shorter ones nest inside -- and spread evenly across the gutter with
 * `CORNER` clearance at each end, which is the room the rounded corners need. A gutter too
 * tight to separate them keeps the midline: overlapping is better than a corner radius
 * larger than the segment it is rounding.
 *
 * @param {Object[]} edges
 * @param {Array<{top: number, bottom: number}>} bands
 * @returns {Map<string, number>} jog key -> lane y
 */
function assignGutterLanes(edges, bands) {
  /** @type {Map<number, Array<{key: string, span: number, mid: number, order: number}>>} */
  const byGutter = new Map();

  for (const e of edges) {
    if (e.self) continue;
    const spine = [e.u, ...e.chain, e.v];
    for (let i = 0; i + 1 < spine.length; i += 1) {
      const a = spine[i];
      const b = spine[i + 1];
      const band = bands[a.layer];
      const next = bands[b.layer];
      if (!band || !next) continue;
      if (Math.abs(a.x - b.x) <= 1 || next.top - band.bottom <= CORNER * 2) continue;
      if (!byGutter.has(a.layer)) byGutter.set(a.layer, []);
      byGutter.get(a.layer).push({
        key: jogKey(e, i),
        span: Math.abs(a.x - b.x),
        mid: (a.x + b.x) / 2,
        order: e.index,
      });
    }
  }

  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [layer, jogs] of byGutter) {
    const top = bands[layer].bottom;
    const bottom = bands[layer + 1].top;
    if (jogs.length < 2) continue; // a lone jog keeps the midline

    const usable = (bottom - CORNER) - (top + CORNER);
    // Every lane still needs CORNER of vertical room on each side to round its turns.
    if (usable < jogs.length * CORNER) continue;

    // Deterministic: widest span first, then leftmost, then declaration order.
    jogs.sort((p, q) => (q.span - p.span) || (p.mid - q.mid) || (p.order - q.order));
    const step = usable / (jogs.length + 1);
    for (let i = 0; i < jogs.length; i += 1) {
      out.set(jogs[i].key, top + CORNER + step * (i + 1));
    }
  }
  return out;
}

function routeEdges(edges, layers) {
  const bands = layerBands(layers);
  const lanes = assignGutterLanes(edges, bands);
  /** @type {Map<Object, Object>} */
  const routes = new Map();
  for (const e of edges) {
    if (e.self) {
      routes.set(e, { points: [], labelPoint: null, self: true });
      continue;
    }
    const spine = [e.u, ...e.chain, e.v];

    const points = [];
    for (let i = 0; i + 1 < spine.length; i += 1) {
      const a = spine[i];
      const b = spine[i + 1];
      points.push({ x: a.x, y: a.y });
      const exit = bands[a.layer] ? bands[a.layer].bottom : a.y + a.h / 2;
      const entry = bands[b.layer] ? bands[b.layer].top : b.y - b.h / 2;
      if (Math.abs(a.x - b.x) > 1 && entry - exit > CORNER * 2) {
        const mid = lanes.get(jogKey(e, i)) ?? (exit + entry) / 2;
        points.push({ x: a.x, y: mid });
        points.push({ x: b.x, y: mid });
      }
    }
    const tail = spine[spine.length - 1];
    points.push({ x: tail.x, y: tail.y });

    const labelPoint = e.labelDummy
      ? { x: e.labelDummy.x, y: e.labelDummy.y }
      : null;
    const cleaned = dropCollinear(points);
    routes.set(e, { points: e.reversed ? cleaned.reverse() : cleaned, labelPoint, self: false });
  }
  return routes;
}

/**
 * The vertical extent each layer's nodes actually occupy. The gutter between consecutive
 * bands is empty by construction (see {@link assignY}), which is what makes it the only safe
 * place to put an edge's horizontal jog.
 *
 * @param {Object[][]} layers
 * @returns {Array<{top: number, bottom: number}|null>} indexed by layer
 */
function layerBands(layers) {
  return layers.map((layer) => {
    let top = Infinity;
    let bottom = -Infinity;
    for (const n of layer) {
      top = Math.min(top, n.y - n.h / 2);
      bottom = Math.max(bottom, n.y + n.h / 2);
    }
    return Number.isFinite(top) ? { top, bottom } : null;
  });
}

/**
 * @param {Array<{x: number, y: number}>} points
 * @returns {Array<{x: number, y: number}>}
 */
function dropCollinear(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  for (let i = 1; i + 1 < out.length; i += 1) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) < 0.5) {
      out.splice(i, 1);
      i -= 1;
    }
  }
  return out;
}

/**
 * Self loop: a rounded stub off the visual right-hand side of the node. Built in output space
 * because "right" only means anything once the direction transform has been applied.
 *
 * @param {{x: number, y: number, w: number, h: number}} n
 * @returns {Array<{x: number, y: number}>}
 */
function selfLoopPoints(n) {
  const reach = n.w / 2 + Math.max(18, Math.min(32, n.h * 0.6));
  const spread = Math.max(6, n.h * 0.22);
  return [
    { x: n.x, y: n.y },
    { x: n.x + reach, y: n.y - spread },
    { x: n.x + reach, y: n.y + spread },
    { x: n.x, y: n.y },
  ];
}

/* --------------------------------------------------------------------------- output space */

/**
 * Apply the direction transform, trim edge ends onto the shape outlines, normalise to the
 * origin and round.
 *
 * Trimming happens *after* the transform on purpose: a hexagon transposed is not a hexagon, so
 * the outline has to be intersected in the coordinate system the renderer will draw in.
 *
 * @param {Object[]} nodes
 * @param {Object[]} edges
 * @param {Map<Object, Object>} routes
 * @param {Object[]} subs
 * @param {Map<Object, Object>} boxes
 * @param {'TD'|'BT'|'LR'|'RL'} dir
 * @returns {PositionedFlow}
 */
function toOutputSpace(nodes, edges, routes, subs, boxes, dir) {
  const bounds = internalBounds(nodes, routes, boxes);
  const H = bounds.y1 - bounds.y0;

  const map = (p) => {
    const x = p.x - bounds.x0;
    const y = p.y - bounds.y0;
    if (dir === 'LR') return { x: y, y: x };
    if (dir === 'RL') return { x: H - y, y: x };
    if (dir === 'BT') return { x, y: H - y };
    return { x, y };
  };

  /** @type {PositionedNode[]} */
  const outNodes = nodes.map((n) => {
    const c = map({ x: n.x, y: n.y });
    return {
      id: n.id,
      x: c.x,
      y: c.y,
      w: n.realW,
      h: n.realH,
      shape: n.shape,
      label: n.label,
      classes: n.classes,
    };
  });
  const outById = new Map(outNodes.map((n) => [n.id, n]));

  /** @type {PositionedEdge[]} */
  const outEdges = [];
  for (const e of edges) {
    const route = routes.get(e);
    const src = outById.get(e.from);
    const dst = outById.get(e.to);
    const loop = !route || route.self;
    const points = trimEnds(loop ? selfLoopPoints(src) : route.points.map(map), src, dst);
    let labelPos;
    if (loop) {
      let far = src.x;
      for (const p of points) far = Math.max(far, p.x);
      labelPos = { x: far + e.labelW / 2 + EDGE_LABEL_PAD, y: src.y };
    } else {
      labelPos = route.labelPoint ? map(route.labelPoint) : midpointOf(points);
    }
    outEdges.push({
      points,
      kind: e.kind,
      label: e.label,
      labelPos: e.label ? labelPos : null,
      labelWidth: e.labelW,
      labelHeight: e.labelH,
      from: e.from,
      to: e.to,
    });
  }

  /** @type {PositionedSubgraph[]} */
  const outSubs = [];
  for (const s of subs) {
    const b = boxes.get(s);
    if (!b) continue;
    const a = map({ x: b.x0, y: b.y0 });
    const c = map({ x: b.x1, y: b.y1 });
    outSubs.push({
      id: s.id,
      title: s.title,
      x: Math.min(a.x, c.x),
      y: Math.min(a.y, c.y),
      w: Math.abs(c.x - a.x),
      h: Math.abs(c.y - a.y),
      depth: s.depth,
      titleHeight: s.band,
    });
  }

  return normalizeOutput(outNodes, outEdges, outSubs);
}

/**
 * @param {Object[]} nodes
 * @param {Map<Object, Object>} routes
 * @param {Map<Object, Object>} boxes
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 */
function internalBounds(nodes, routes, boxes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const n of nodes) {
    grow(n.x - n.w / 2, n.y - n.h / 2);
    grow(n.x + n.w / 2, n.y + n.h / 2);
  }
  for (const route of routes.values()) {
    for (const p of route.points || []) grow(p.x, p.y);
  }
  for (const b of boxes.values()) {
    grow(b.x0, b.y0);
    grow(b.x1, b.y1);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/**
 * Replace the first and last points -- both node centres -- with the exact point where the
 * polyline leaves the source outline and meets the target outline, so arrowheads sit on the
 * border of a diamond or a circle rather than floating near it.
 *
 * The intersection comes from `svg.js`, which is also where `render/flowchart.js` gets the
 * outline it draws. Two implementations of the same rhombus would drift apart, and the drift
 * shows up as an arrowhead hanging in space.
 *
 * @param {Array<{x: number, y: number}>} points
 * @param {PositionedNode} src
 * @param {PositionedNode} dst
 * @returns {Array<{x: number, y: number}>}
 */
function trimEnds(points, src, dst) {
  if (points.length < 2 || !src || !dst) return points;
  const out = points.slice();
  const head = firstDistinct(out, 0, 1);
  if (head) out[0] = clampToward(src, head, shapeIntersectToward(src.shape, src.x, src.y, src.w, src.h, head));
  const last = out.length - 1;
  const tail = firstDistinct(out, last, -1);
  if (tail) out[last] = clampToward(dst, tail, shapeIntersectToward(dst.shape, dst.x, dst.y, dst.w, dst.h, tail));
  // A clamped endpoint can coincide with the bend it was clamped to; a zero-length segment
  // makes the renderer's corner rounding divide by zero.
  const deduped = dropCollinear(out);
  return deduped.length >= 2 ? deduped : out;
}

/**
 * Keep a trimmed endpoint between the node's centre and the bend it aims at. A node wider than
 * the distance to its first bend would otherwise get an endpoint past that bend, and the
 * polyline would double back on itself.
 *
 * @param {{x: number, y: number}} centre
 * @param {{x: number, y: number}} target
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
function clampToward(centre, target, point) {
  const reach = Math.hypot(target.x - centre.x, target.y - centre.y);
  const got = Math.hypot(point.x - centre.x, point.y - centre.y);
  return got <= reach ? point : { x: target.x, y: target.y };
}

/**
 * @param {Array<{x: number, y: number}>} points
 * @param {number} from
 * @param {number} step
 * @returns {{x: number, y: number}|null}
 */
function firstDistinct(points, from, step) {
  const origin = points[from];
  for (let i = from + step; i >= 0 && i < points.length; i += step) {
    if (Math.hypot(points[i].x - origin.x, points[i].y - origin.y) > 0.5) return points[i];
  }
  return null;
}

/**
 * @param {Array<{x: number, y: number}>} points
 * @returns {{x: number, y: number}} the point halfway along the polyline
 */
function midpointOf(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const seg = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (walked + seg >= total / 2 && seg > 0) {
      const t = (total / 2 - walked) / seg;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    walked += seg;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * Shift everything so the content box starts at the origin, then round. Self loops and label
 * plates can stick out past the node boxes, so the bounds are recomputed here rather than
 * reused.
 *
 * @param {PositionedNode[]} nodes
 * @param {PositionedEdge[]} edges
 * @param {PositionedSubgraph[]} subs
 * @returns {PositionedFlow}
 */
function normalizeOutput(nodes, edges, subs) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const n of nodes) {
    grow(n.x - n.w / 2, n.y - n.h / 2);
    grow(n.x + n.w / 2, n.y + n.h / 2);
  }
  for (const e of edges) {
    for (const p of e.points) grow(p.x, p.y);
    if (e.labelPos) {
      grow(e.labelPos.x - e.labelWidth / 2 - EDGE_LABEL_PAD, e.labelPos.y - e.labelHeight / 2 - EDGE_LABEL_PAD);
      grow(e.labelPos.x + e.labelWidth / 2 + EDGE_LABEL_PAD, e.labelPos.y + e.labelHeight / 2 + EDGE_LABEL_PAD);
    }
  }
  for (const s of subs) {
    grow(s.x, s.y);
    grow(s.x + s.w, s.y + s.h);
  }
  if (!Number.isFinite(x0)) return { width: 0, height: 0, nodes, edges, subgraphs: subs };

  for (const n of nodes) {
    n.x = round2(n.x - x0);
    n.y = round2(n.y - y0);
  }
  for (const e of edges) {
    for (const p of e.points) {
      p.x = round2(p.x - x0);
      p.y = round2(p.y - y0);
    }
    if (e.labelPos) {
      e.labelPos.x = round2(e.labelPos.x - x0);
      e.labelPos.y = round2(e.labelPos.y - y0);
    }
    e.labelWidth = round2(e.labelWidth);
    e.labelHeight = round2(e.labelHeight);
  }
  for (const s of subs) {
    s.x = round2(s.x - x0);
    s.y = round2(s.y - y0);
    s.w = round2(s.w);
    s.h = round2(s.h);
    s.titleHeight = round2(s.titleHeight);
  }
  return {
    width: round2(x1 - x0),
    height: round2(y1 - y0),
    nodes,
    edges,
    subgraphs: subs,
  };
}

/* ----------------------------------------------------------------------------- small stuff */

/**
 * @param {'TD'|'TB'|'BT'|'LR'|'RL'|string|null|undefined} dir
 * @returns {'TD'|'BT'|'LR'|'RL'}
 */
function normalizeDirection(dir) {
  const d = String(dir == null ? 'TD' : dir).trim().toUpperCase();
  if (d === 'BT') return 'BT';
  if (d === 'LR') return 'LR';
  if (d === 'RL') return 'RL';
  return 'TD';
}

/**
 * @param {Map<string, Object>|Object} source
 * @returns {Array<[string, Object]>}
 */
function toEntries(source) {
  if (source instanceof Map) return Array.from(source.entries());
  if (Array.isArray(source)) return source.map((n) => [String(n && n.id), n]);
  if (source && typeof source === 'object') return Object.entries(source);
  return [];
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @param {number} v
 * @returns {number} v rounded up to the next even integer
 */
function snap2(v) {
  return Math.ceil(v / 2) * 2;
}

/**
 * @param {number} v
 * @returns {number}
 */
function round2(v) {
  return Math.round(v * 100) / 100;
}
