/**
 * The vocabulary of the diagram subsystem: every shape of data that crosses a module
 * boundary, plus the pure geometry helpers those modules would otherwise each reinvent.
 *
 * Nothing here has behaviour beyond arithmetic. Parsers produce these shapes, layout
 * rewrites them, renderers read them, and this file is the only place their field names are
 * written down -- so a rename is a single edit rather than a hunt through six modules.
 *
 * Coordinates follow SVG convention throughout: x grows right, y grows *down*, and angles
 * are radians from `Math.atan2(dy, dx)`, so 0 points right and `+PI/2` points down.
 *
 * @module markdown/mermaid/model
 */

// ---------------------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------------------

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * An axis-aligned bounding box in min/max form. Kept distinct from {@link Rect} on purpose:
 * unions and containment tests are trivial in min/max form and error-prone in x/y/w/h form,
 * and mixing the two silently is how a subgraph box ends up half a node too small.
 *
 * @typedef {Object} BBox
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * @typedef {Object} Rect
 * @property {number} x left edge
 * @property {number} y top edge
 * @property {number} w
 * @property {number} h
 */

// ---------------------------------------------------------------------------------------
// Flowchart -- parse output (SPEC-MERMAID 5a)
// ---------------------------------------------------------------------------------------

/** @typedef {'TD'|'BT'|'LR'|'RL'} FlowDirection */

/**
 * @typedef {'rect'|'round'|'stadium'|'subroutine'|'cylinder'|'circle'|'diamond'
 *   |'hexagon'|'parallelogram'|'parallelogram-alt'|'flag'} FlowShape
 */

/** @typedef {'arrow'|'open'|'dotted'|'thick'|'cross'|'circle'} FlowEdgeKind */

/**
 * @typedef {Object} FlowNode
 * @property {string} id
 * @property {string[]} label one entry per explicit line (`<br/>` already applied)
 * @property {FlowShape} shape
 * @property {string[]} classes `classDef` / `:::` names, without the `node--` prefix
 * @property {number} line 1-based, in the original document
 */

/**
 * @typedef {Object} FlowEdge
 * @property {string} from source node id
 * @property {string} to target node id
 * @property {FlowEdgeKind} kind
 * @property {string[]|null} label
 * @property {number} line 1-based, in the original document
 */

/**
 * @typedef {Object} FlowSubgraph
 * @property {string} id
 * @property {string} title
 * @property {string[]} nodeIds direct members only; descendants live on `children`
 * @property {FlowSubgraph[]} children
 * @property {FlowDirection|null} direction from an inner `direction` line
 */

/**
 * @typedef {Object} FlowGraph
 * @property {FlowDirection} direction
 * @property {Map<string, FlowNode>} nodes insertion-ordered, and iterated in that order
 * @property {FlowEdge[]} edges
 * @property {FlowSubgraph[]} subgraphs top level only; nesting is on `children`
 */

// ---------------------------------------------------------------------------------------
// Flowchart -- layout output (SPEC-MERMAID 5b)
// ---------------------------------------------------------------------------------------

/**
 * @typedef {Object} PositionedNode
 * @property {string} id
 * @property {number} x centre
 * @property {number} y centre
 * @property {number} w
 * @property {number} h
 * @property {FlowShape} shape
 * @property {string[]} label
 * @property {string[]} classes
 */

/**
 * @typedef {Object} PositionedEdge
 * @property {Point[]} points source anchor first, target anchor last
 * @property {FlowEdgeKind} kind
 * @property {string[]|null} label
 * @property {Point|null} labelPos centre of the label plate
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} PositionedSubgraph
 * @property {string} title
 * @property {number} x left edge
 * @property {number} y top edge
 * @property {number} w
 * @property {number} h
 * @property {number} depth 0 for a top-level box; deeper boxes nest inside shallower ones
 */

/**
 * @typedef {Object} PositionedFlow
 * @property {number} width content box, before any margin
 * @property {number} height content box, before any margin
 * @property {PositionedNode[]} nodes
 * @property {PositionedEdge[]} edges
 * @property {PositionedSubgraph[]} subgraphs
 */

// ---------------------------------------------------------------------------------------
// Sequence diagram (SPEC-MERMAID 6)
// ---------------------------------------------------------------------------------------

/**
 * A message arrow decomposed into the two things that actually vary. Mermaid spells eight
 * combinations (`->`, `->>`, `-->>`, `-x`, `--)` …); storing them as line style plus head
 * style keeps the renderer from carrying an eight-way switch.
 *
 * @typedef {Object} SequenceArrow
 * @property {'solid'|'dashed'} line
 * @property {'arrow'|'open'|'async'|'cross'|'none'} head
 */

/**
 * @typedef {Object} SequenceParticipant
 * @property {string} id
 * @property {string[]} label display text, `as` alias applied
 * @property {'participant'|'actor'} kind
 * @property {number} index declaration / first-appearance order
 * @property {boolean} declared false when auto-created from a message (MD082)
 * @property {number} line
 */

/**
 * @typedef {Object} SequenceMessage
 * @property {'message'} type
 * @property {string} from participant id
 * @property {string} to participant id; equal to `from` for a self-message
 * @property {string[]} label
 * @property {SequenceArrow} arrow
 * @property {boolean} activate `+` suffix -- open an activation on the target
 * @property {boolean} deactivate `-` suffix -- close the target's activation
 * @property {number} line
 */

/**
 * @typedef {Object} SequenceNote
 * @property {'note'} type
 * @property {'left'|'right'|'over'} placement
 * @property {string[]} participants one id for left/right, one or two for over
 * @property {string[]} label
 * @property {number} line
 */

/**
 * @typedef {Object} SequenceActivation
 * @property {'activate'|'deactivate'} type
 * @property {string} participant
 * @property {number} line
 */

/**
 * A `loop` / `alt` / `opt` / `par` / `critical` / `break` / `rect` frame. `sections` holds
 * one entry per `else` / `and` division; a `loop` has exactly one.
 *
 * @typedef {Object} SequenceBlock
 * @property {'block'} type
 * @property {'loop'|'alt'|'opt'|'par'|'critical'|'break'|'rect'} kind
 * @property {Array<{ label: string, items: SequenceItem[], line: number }>} sections
 * @property {number} line
 */

/** @typedef {SequenceMessage|SequenceNote|SequenceActivation|SequenceBlock} SequenceItem */

/**
 * @typedef {Object} SequenceModel
 * @property {Map<string, SequenceParticipant>} participants insertion-ordered
 * @property {SequenceItem[]} items
 * @property {boolean} autonumber
 */

/**
 * @typedef {Object} PositionedLifeline
 * @property {string} id
 * @property {string[]} label
 * @property {'participant'|'actor'} kind
 * @property {number} x centre of the column
 * @property {number} w header box width
 * @property {number} h header box height
 * @property {number} top y of the header box
 * @property {number} bottom y where the lifeline stops
 */

/**
 * @typedef {Object} PositionedActivation
 * @property {string} participant
 * @property {number} x left edge of the bar
 * @property {number} y top edge
 * @property {number} w
 * @property {number} h
 * @property {number} depth nesting level; each level offsets the bar
 */

/**
 * @typedef {Object} PositionedMessage
 * @property {Point[]} points two points, or a loop for a self-message
 * @property {SequenceArrow} arrow
 * @property {string[]} label
 * @property {Point|null} labelPos
 * @property {boolean} selfMessage
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} PositionedNote
 * @property {string[]} label
 * @property {number} x left edge
 * @property {number} y top edge
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} PositionedBlock
 * @property {string} kind
 * @property {string} label
 * @property {number} x left edge
 * @property {number} y top edge
 * @property {number} w
 * @property {number} h
 * @property {number} depth
 * @property {Array<{ label: string, y: number }>} dividers `else` / `and` rules
 */

/**
 * @typedef {Object} PositionedSequence
 * @property {number} width content box, before any margin
 * @property {number} height content box, before any margin
 * @property {PositionedLifeline[]} lifelines
 * @property {PositionedLifeline[]} repeatedHeaders bottom row, empty when not needed
 * @property {PositionedActivation[]} activations
 * @property {PositionedMessage[]} messages
 * @property {PositionedNote[]} notes
 * @property {PositionedBlock[]} blocks
 */

// ---------------------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------------------

/** Characters legal in the id fragments we generate; everything else becomes a hyphen. */
const ID_UNSAFE = /[^A-Za-z0-9_-]+/g;

/**
 * Reduce an arbitrary string to something safe inside an XML `id`. Case is preserved,
 * because node ids differing only in case (`A` and `a`) are distinct in mermaid and folding
 * them would make two nodes share one marker.
 * @param {string} value
 * @returns {string}
 */
function sanitizeIdPart(value) {
  return String(value ?? '').replace(ID_UNSAFE, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the id namespace for one diagram.
 *
 * Two diagrams on one page must never share a marker id, or the second one silently adopts
 * the first one's arrowheads. The prefix carries the diagram's index on the page (`d1`,
 * `d2`), which the renderer already tracks, so uniqueness comes from position rather than
 * from a random suffix -- and the output stays byte-identical between builds.
 *
 * The returned function is *stable*: the same name always yields the same id, which is what
 * marker reuse wants (one `arrow` marker, referenced by every arrow edge). Call
 * `.unique(name)` for the rarer case where each call genuinely needs its own id.
 *
 * @param {string} prefix e.g. `'d1'`
 * @returns {((name: string) => string) & { unique: (name: string) => string, prefix: string }}
 */
export function newIdFactory(prefix) {
  const base = sanitizeIdPart(prefix) || 'd';
  /** @type {Map<string, number>} */
  const counts = new Map();

  /** @type {any} */
  const factory = (name) => `${base}-${sanitizeIdPart(name) || 'id'}`;

  factory.unique = (name) => {
    const part = sanitizeIdPart(name) || 'id';
    const seen = (counts.get(part) || 0) + 1;
    counts.set(part, seen);
    return seen === 1 ? `${base}-${part}` : `${base}-${part}-${seen}`;
  };
  factory.prefix = base;

  return factory;
}

// ---------------------------------------------------------------------------------------
// Point helpers
// ---------------------------------------------------------------------------------------

/**
 * @param {number} x
 * @param {number} y
 * @returns {Point}
 */
export function pt(x, y) {
  return { x, y };
}

/**
 * @param {Point} a
 * @param {Point} b
 * @returns {number} euclidean distance
 */
export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * @param {Point} a
 * @param {Point} b
 * @returns {Point}
 */
export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Direction from `a` to `b`, in radians, SVG orientation (y down).
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
export function angleBetween(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * @param {Point} p
 * @param {number} dx
 * @param {number} dy
 * @returns {Point}
 */
export function translate(p, dx, dy) {
  return { x: p.x + dx, y: p.y + dy };
}

/**
 * Point `t` of the way from `a` to `b`.
 * @param {Point} a
 * @param {Point} b
 * @param {number} t
 * @returns {Point}
 */
export function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Drop consecutive duplicates from a polyline. Layout routinely produces them -- a dummy
 * node landing exactly on its predecessor's column, an edge whose anchor coincides with its
 * first bend -- and they turn into zero-length segments that break corner rounding.
 * @param {Point[]} points
 * @param {number} [epsilon]
 * @returns {Point[]}
 */
export function dedupePoints(points, epsilon = 0.01) {
  /** @type {Point[]} */
  const out = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) <= epsilon && Math.abs(last.y - p.y) <= epsilon) continue;
    out.push(p);
  }
  return out;
}

/**
 * Remove a middle point that lies on the straight line between its neighbours. Keeps corner
 * rounding from emitting a zero-radius arc at a non-corner.
 * @param {Point[]} points
 * @param {number} [epsilon] cross-product tolerance, in px squared
 * @returns {Point[]}
 */
export function simplifyPolyline(points, epsilon = 0.05) {
  const pts = dedupePoints(points);
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > epsilon) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------------------

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Snap to a grid. Node dimensions land on a 2px grid so a 1.5px stroke straddles a whole
 * pixel boundary instead of a half one, which is the difference between a crisp hairline
 * and a grey smear at 1x.
 * @param {number} value
 * @param {number} [step]
 * @returns {number}
 */
export function snap(value, step = 2) {
  if (!Number.isFinite(value) || !(step > 0)) return 0;
  // `+ 0` collapses -0, which would otherwise serialise differently from 0.
  return Math.round(value / step) * step + 0;
}

// ---------------------------------------------------------------------------------------
// Bounding-box helpers
// ---------------------------------------------------------------------------------------

/**
 * An inverted box, so the first {@link unionBox} with a real box yields that box.
 * @returns {BBox}
 */
export function emptyBox() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

/**
 * @param {BBox} box
 * @returns {boolean} false once anything has been unioned into it
 */
export function isEmptyBox(box) {
  return !box || !(box.minX <= box.maxX) || !(box.minY <= box.maxY);
}

/**
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {number} h
 * @returns {BBox}
 */
export function boxFromCenter(cx, cy, w, h) {
  return { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 };
}

/**
 * @param {number} x left edge
 * @param {number} y top edge
 * @param {number} w
 * @param {number} h
 * @returns {BBox}
 */
export function boxFromRect(x, y, w, h) {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

/**
 * @param {Point[]} points
 * @returns {BBox}
 */
export function boxFromPoints(points) {
  const box = emptyBox();
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < box.minX) box.minX = p.x;
    if (p.y < box.minY) box.minY = p.y;
    if (p.x > box.maxX) box.maxX = p.x;
    if (p.y > box.maxY) box.maxY = p.y;
  }
  return box;
}

/**
 * @param {BBox} a
 * @param {BBox} b
 * @returns {BBox} a new box; neither input is mutated
 */
export function unionBox(a, b) {
  if (isEmptyBox(a)) return { ...b };
  if (isEmptyBox(b)) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Inflate a box on every side. Negative padding shrinks it.
 * @param {BBox} box
 * @param {number} pad
 * @param {number} [padY] when the vertical inset differs, e.g. a subgraph title band
 * @returns {BBox}
 */
export function growBox(box, pad, padY = pad) {
  if (isEmptyBox(box)) return { ...box };
  return {
    minX: box.minX - pad,
    minY: box.minY - padY,
    maxX: box.maxX + pad,
    maxY: box.maxY + padY,
  };
}

/**
 * @param {BBox} box
 * @returns {Rect}
 */
export function boxToRect(box) {
  if (isEmptyBox(box)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: box.minX, y: box.minY, w: box.maxX - box.minX, h: box.maxY - box.minY };
}

/**
 * @param {BBox} box
 * @returns {Point} centre
 */
export function boxCenter(box) {
  if (isEmptyBox(box)) return { x: 0, y: 0 };
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

/**
 * True when `inner` lies entirely within `outer`. Used by the layout tests to assert that
 * every node sits inside its subgraph and that nested boxes really nest.
 * @param {BBox} outer
 * @param {BBox} inner
 * @param {number} [tolerance]
 * @returns {boolean}
 */
export function boxContains(outer, inner, tolerance = 0.001) {
  if (isEmptyBox(outer) || isEmptyBox(inner)) return false;
  return inner.minX >= outer.minX - tolerance
    && inner.minY >= outer.minY - tolerance
    && inner.maxX <= outer.maxX + tolerance
    && inner.maxY <= outer.maxY + tolerance;
}

/**
 * True when two boxes share area, optionally requiring a minimum gap between them.
 * @param {BBox} a
 * @param {BBox} b
 * @param {number} [gap] treat boxes closer than this as overlapping
 * @returns {boolean}
 */
export function boxesOverlap(a, b, gap = 0) {
  if (isEmptyBox(a) || isEmptyBox(b)) return false;
  return a.minX < b.maxX + gap
    && b.minX < a.maxX + gap
    && a.minY < b.maxY + gap
    && b.minY < a.maxY + gap;
}
