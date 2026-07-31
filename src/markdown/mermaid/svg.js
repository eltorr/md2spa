/**
 * Low-level SVG emitters and the flowchart shape library.
 *
 * Two invariants are enforced here rather than trusted to callers:
 *
 *   1. **Numbers are formatted in exactly one place.** `0.1 + 0.2` must not reach the output
 *      as `0.30000000000000004` on one machine and `0.3` on another, and `-0` must not
 *      appear where `0` did yesterday. Everything numeric goes through {@link num}.
 *   2. **Text is escaped in exactly one place.** {@link textElement} is the only function
 *      that puts author-controlled characters inside an element, and it runs them through
 *      `escapeHtml` from `util/html.js` -- the same function the rest of the pipeline uses.
 *
 * Nothing here emits `style=`, `fill=` or `stroke=`. Colour lives in `theme/style.css`,
 * which is what makes a diagram follow the user's theme instead of fighting it.
 *
 * Angles are radians in SVG orientation: 0 points right, `+PI/2` points *down*.
 *
 * @module markdown/mermaid/svg
 */

import { escapeHtml, attrs } from '../../util/html.js';

/** Tolerance for geometry comparisons, in px. Well below a device pixel. */
const EPS = 1e-9;

// ---------------------------------------------------------------------------------------
// Shape geometry constants
// ---------------------------------------------------------------------------------------

/** Corner radius for the `round` shape, before clamping to the node's half-extent. */
export const ROUND_RADIUS = 8;

/** Distance from each vertical edge to the `subroutine` shape's inner rules. */
export const SUBROUTINE_INSET = 8;

/** Vertical radius of a cylinder's end caps, as a fraction of the node height. */
export const CYLINDER_RY_RATIO = 0.14;

/** Cylinder cap radius floor and ceiling, in px. */
export const CYLINDER_RY_MIN = 4;
export const CYLINDER_RY_MAX = 12;

/** Horizontal inset of a hexagon's flat edges, as a fraction of the node height. */
export const HEXAGON_SLANT = 0.35;

/** Horizontal offset of a parallelogram's slanted sides, as a fraction of the height. */
export const PARALLELOGRAM_SLANT = 0.30;

/** Depth of the `flag` shape's left-hand notch, as a fraction of the height. */
export const FLAG_NOTCH = 0.50;

/** No slanted feature may eat more than this fraction of the node width. */
const MAX_SLANT_OF_WIDTH = 0.30;

/** Shape used when a caller asks for a name the library does not know. */
export const DEFAULT_SHAPE = 'rect';

// ---------------------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------------------

/**
 * Format a number for the output stream.
 *
 * Three decimals is finer than any display can resolve at the sizes involved, and rounding
 * there is what makes two builds of the same source byte-identical: without it, an
 * accumulated float difference of 1e-16 shows up as a different digit string.
 *
 * @param {number} value
 * @param {number} [precision] decimal places
 * @returns {string}
 */
export function num(value, precision = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const factor = 10 ** precision;
  const rounded = Math.round(n * factor) / factor;
  // `rounded === 0` is true for -0, so this also normalises the sign away.
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Emit one element.
 *
 * Numeric attribute values are formatted through {@link num}; everything else is escaped by
 * `attrs()`. Attribute order follows the object's insertion order, which is stable in ES,
 * so the output is deterministic. An element with no children self-closes.
 *
 * @param {string} tag
 * @param {Record<string, string|number|boolean|null|undefined>} [attributes]
 * @param {string|string[]|null} [children] already-escaped markup, not raw text
 * @returns {string}
 */
export function el(tag, attributes = {}, children = null) {
  /** @type {Record<string, string|boolean|null|undefined>} */
  const formatted = {};
  for (const [name, value] of Object.entries(attributes || {})) {
    formatted[name] = typeof value === 'number' ? num(value) : value;
  }
  const open = `<${tag}${attrs(formatted)}`;

  const body = Array.isArray(children)
    ? children.filter((child) => child !== null && child !== undefined && child !== '').join('')
    : (children ?? '');

  return body === '' ? `${open}/>` : `${open}>${body}</${tag}>`;
}

/**
 * Build a `d` attribute from a command list.
 *
 * Commands are either ready-made strings or `[op, ...args]` tuples -- `['M', 0, 10]`,
 * `['A', rx, ry, 0, 0, 1, x, y]`, `['Z']`. Arguments are formatted through {@link num},
 * so callers can hand over raw floats.
 *
 * @param {Array<string|Array<string|number>>} commands
 * @returns {string}
 */
export function path(commands) {
  const parts = [];
  for (const command of commands) {
    if (command === null || command === undefined) continue;
    if (typeof command === 'string') {
      const trimmed = command.trim();
      if (trimmed) parts.push(trimmed);
      continue;
    }
    if (!Array.isArray(command) || command.length === 0) continue;
    const [op, ...args] = command;
    parts.push(args.length === 0 ? String(op) : `${op} ${args.map((a) => num(a)).join(' ')}`);
  }
  return parts.join(' ');
}

/**
 * Polyline with rounded corners, as a `d` string.
 *
 * Each corner is a quadratic Bézier whose control point is the original vertex, cut back by
 * `radius` along both adjacent segments. The cut is capped at half of each segment, so two
 * corners sharing a short segment can never overrun each other and produce a self-crossing
 * curve -- which is the failure that makes a routed edge look like a knot.
 *
 * Collinear vertices are passed through as plain line joins: rounding a straight line
 * introduces a visible wobble.
 *
 * @param {Array<{x: number, y: number}>} points
 * @param {number} [radius]
 * @returns {string} the `d` attribute, or `''` for an empty point list
 */
export function roundedPolyline(points, radius = 0) {
  /** @type {Array<{x: number, y: number}>} */
  const pts = [];
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    pts.push(p);
  }

  if (pts.length === 0) return '';
  if (pts.length === 1) return path([['M', pts[0].x, pts[0].y]]);

  /** @type {Array<string|Array<string|number>>} */
  const commands = [['M', pts[0].x, pts[0].y]];

  if (radius > EPS) {
    for (let i = 1; i < pts.length - 1; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const next = pts[i + 1];

      const inX = prev.x - cur.x;
      const inY = prev.y - cur.y;
      const outX = next.x - cur.x;
      const outY = next.y - cur.y;
      const inLen = Math.hypot(inX, inY);
      const outLen = Math.hypot(outX, outY);
      if (inLen < EPS || outLen < EPS) continue;

      // Normalised cross product: 0 when the three points are collinear.
      const cross = Math.abs((inX * outY - inY * outX) / (inLen * outLen));
      if (cross < 1e-6) continue;

      const r = Math.min(radius, inLen / 2, outLen / 2);
      commands.push(['L', cur.x + (inX / inLen) * r, cur.y + (inY / inLen) * r]);
      commands.push(['Q', cur.x, cur.y, cur.x + (outX / outLen) * r, cur.y + (outY / outLen) * r]);
    }
  } else {
    for (let i = 1; i < pts.length - 1; i += 1) commands.push(['L', pts[i].x, pts[i].y]);
  }

  const end = pts[pts.length - 1];
  commands.push(['L', end.x, end.y]);
  return path(commands);
}

/**
 * A multi-line `<text>` element.
 *
 * Every line gets its own `<tspan>` with an explicit `x` and `dy`, including the first
 * (`dy="0"`). Safari and Chromium disagree about where a `<tspan>` without `dy` lands when
 * `dominant-baseline` is in play, and a diagram whose labels sit one line low in one browser
 * is a diagram nobody trusts. `y` is the baseline of the first line, computed by the caller.
 *
 * @param {string[]} lines raw text; escaped here
 * @param {{ x: number, y: number, className?: string|null, lineHeight?: number,
 *           anchor?: string|null, extra?: Record<string, string|number|null> }} options
 * @returns {string}
 */
export function textElement(lines, options) {
  const { x, y, className = null, lineHeight = 0, anchor = null, extra = {} } = options || {};
  const spans = (lines || []).map((line, index) => el(
    'tspan',
    { x, dy: index === 0 ? 0 : lineHeight },
    escapeHtml(line ?? ''),
  ));
  return el('text', { class: className, x, y, 'text-anchor': anchor, ...extra }, spans);
}

// ---------------------------------------------------------------------------------------
// Intersection primitives
// ---------------------------------------------------------------------------------------

/**
 * Where a ray leaving the centre crosses an axis-aligned rectangle.
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {number} h
 * @param {number} angle
 * @returns {{x: number, y: number}}
 */
function intersectRect(cx, cy, w, h, angle) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const tx = Math.abs(dx) < EPS ? Infinity : (w / 2) / Math.abs(dx);
  const ty = Math.abs(dy) < EPS ? Infinity : (h / 2) / Math.abs(dy);
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t)) return { x: cx, y: cy };
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Where a ray leaving the centre crosses an axis-aligned ellipse.
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {number} h
 * @param {number} angle
 * @returns {{x: number, y: number}}
 */
function intersectEllipse(cx, cy, w, h, angle) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const k = Math.hypot(dx / (w / 2), dy / (h / 2));
  if (k < EPS) return { x: cx, y: cy };
  const t = 1 / k;
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Where a ray leaving `(cx, cy)` first crosses a closed polygon.
 *
 * The *first* crossing is the right answer for concave outlines too (the `flag` shape has a
 * notch), because the visible boundary is whatever the ray reaches first on its way out.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {Array<{x: number, y: number}>} points
 * @param {number} angle
 * @returns {{x: number, y: number}|null} null when the ray misses every edge
 */
function intersectPolygon(cx, cy, points, angle) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;

    const ax = a.x - cx;
    const ay = a.y - cy;
    const t = (ax * ey - ay * ex) / denom;   // distance along the ray
    const u = (ax * dy - ay * dx) / denom;   // position along the edge, 0..1
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
  }

  if (!Number.isFinite(best)) return null;
  return { x: cx + dx * best, y: cy + dy * best };
}

/**
 * Far intersection of a ray from the origin with a circle. The near root is inside the
 * rounded rectangle we are tracing; the far one is on the visible arc.
 * @param {number} dx unit direction
 * @param {number} dy unit direction
 * @param {number} ox circle centre
 * @param {number} oy circle centre
 * @param {number} r
 * @returns {number|null} distance along the ray
 */
function rayCircleFar(dx, dy, ox, oy, r) {
  const b = dx * ox + dy * oy;
  const c = ox * ox + oy * oy - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  return b + Math.sqrt(disc);
}

/**
 * Both roots of a ray/ellipse intersection, with the ray origin expressed relative to the
 * ellipse centre.
 * @param {number} ox
 * @param {number} oy
 * @param {number} dx unit direction
 * @param {number} dy unit direction
 * @param {number} rx
 * @param {number} ry
 * @returns {number[]} zero, one or two distances along the ray
 */
function rayEllipseRoots(ox, oy, dx, dy, rx, ry) {
  const a = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  if (Math.abs(a) < 1e-12) return [];
  const b = 2 * ((ox * dx) / (rx * rx) + (oy * dy) / (ry * ry));
  const c = (ox * ox) / (rx * rx) + (oy * oy) / (ry * ry) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

/**
 * Where a ray leaving the centre crosses a rounded rectangle: the plain rectangle
 * everywhere except the four corner quadrants, where it crosses the corner arc.
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {number} h
 * @param {number} angle
 * @param {number} radius already clamped
 * @returns {{x: number, y: number}}
 */
function intersectRoundedRect(cx, cy, w, h, angle, radius) {
  const base = intersectRect(cx, cy, w, h, angle);
  if (radius <= EPS) return base;

  const ex = w / 2 - radius;
  const ey = h / 2 - radius;
  const ix = base.x - cx;
  const iy = base.y - cy;
  // On a flat run, the rectangle hit is already correct.
  if (Math.abs(ix) <= ex + 1e-9 || Math.abs(iy) <= ey + 1e-9) return base;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const t = rayCircleFar(dx, dy, ix < 0 ? -ex : ex, iy < 0 ? -ey : ey, radius);
  if (t === null || t <= 0) return base;
  return { x: cx + dx * t, y: cy + dy * t };
}

// ---------------------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------------------

/**
 * @param {number} radius
 * @param {number} hw half width
 * @param {number} hh half height
 * @returns {number}
 */
function clampRadius(radius, hw, hh) {
  return Math.max(0, Math.min(radius, hw, hh));
}

/**
 * A slanted feature's horizontal extent: driven by the node height so the angle stays
 * constant, but never allowed to swallow a narrow node.
 * @param {number} w
 * @param {number} h
 * @param {number} ratio
 * @returns {number}
 */
function slantOf(w, h, ratio) {
  return Math.min(h * ratio, w * MAX_SLANT_OF_WIDTH);
}

/**
 * @param {number} h
 * @returns {number} vertical radius of a cylinder's end caps
 */
function cylinderRy(h) {
  return Math.min(Math.max(h * CYLINDER_RY_RATIO, CYLINDER_RY_MIN), CYLINDER_RY_MAX, h * 0.35);
}

/**
 * @param {Array<{x: number, y: number}>} points
 * @returns {string}
 */
function polygonPath(points) {
  /** @type {Array<string|Array<string|number>>} */
  const commands = [['M', points[0].x, points[0].y]];
  for (let i = 1; i < points.length; i += 1) commands.push(['L', points[i].x, points[i].y]);
  commands.push(['Z']);
  return path(commands);
}

/**
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {number} h
 * @param {number} radius
 * @returns {string}
 */
function roundedRectPath(cx, cy, w, h, radius) {
  const l = cx - w / 2;
  const r = cx + w / 2;
  const t = cy - h / 2;
  const b = cy + h / 2;
  const rr = clampRadius(radius, w / 2, h / 2);
  if (rr <= EPS) {
    return path([['M', l, t], ['H', r], ['V', b], ['H', l], ['Z']]);
  }
  return path([
    ['M', l + rr, t],
    ['H', r - rr],
    ['A', rr, rr, 0, 0, 1, r, t + rr],
    ['V', b - rr],
    ['A', rr, rr, 0, 0, 1, r - rr, b],
    ['H', l + rr],
    ['A', rr, rr, 0, 0, 1, l, b - rr],
    ['V', t + rr],
    ['A', rr, rr, 0, 0, 1, l + rr, t],
    ['Z'],
  ]);
}

// --- per-shape polygon vertices, clockwise from the top-left ---------------------------

/** @param {number} cx @param {number} cy @param {number} w @param {number} h */
const rectPoints = (cx, cy, w, h) => [
  { x: cx - w / 2, y: cy - h / 2 },
  { x: cx + w / 2, y: cy - h / 2 },
  { x: cx + w / 2, y: cy + h / 2 },
  { x: cx - w / 2, y: cy + h / 2 },
];

/** @param {number} cx @param {number} cy @param {number} w @param {number} h */
const diamondPoints = (cx, cy, w, h) => [
  { x: cx, y: cy - h / 2 },
  { x: cx + w / 2, y: cy },
  { x: cx, y: cy + h / 2 },
  { x: cx - w / 2, y: cy },
];

/** @param {number} cx @param {number} cy @param {number} w @param {number} h */
const hexagonPoints = (cx, cy, w, h) => {
  const s = slantOf(w, h, HEXAGON_SLANT);
  return [
    { x: cx - w / 2 + s, y: cy - h / 2 },
    { x: cx + w / 2 - s, y: cy - h / 2 },
    { x: cx + w / 2, y: cy },
    { x: cx + w / 2 - s, y: cy + h / 2 },
    { x: cx - w / 2 + s, y: cy + h / 2 },
    { x: cx - w / 2, y: cy },
  ];
};

/** `[/text/]` -- leans right. @param {number} cx @param {number} cy @param {number} w @param {number} h */
const parallelogramPoints = (cx, cy, w, h) => {
  const s = slantOf(w, h, PARALLELOGRAM_SLANT);
  return [
    { x: cx - w / 2 + s, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2 - s, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
};

/** `[\text\]` -- leans left. @param {number} cx @param {number} cy @param {number} w @param {number} h */
const parallelogramAltPoints = (cx, cy, w, h) => {
  const s = slantOf(w, h, PARALLELOGRAM_SLANT);
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2 - s, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2 + s, y: cy + h / 2 },
  ];
};

/** `A>text]` -- a rectangle whose left edge is notched inward. */
const flagPoints = (cx, cy, w, h) => {
  const n = slantOf(w, h, FLAG_NOTCH);
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
    { x: cx - w / 2 + n, y: cy },
  ];
};

/**
 * Build a polygon-backed shape entry.
 * @param {(cx: number, cy: number, w: number, h: number) => Array<{x: number, y: number}>} points
 * @param {(labelW: number, labelH: number) => {w: number, h: number}} fit
 * @returns {ShapeDef}
 */
function polygonShape(points, fit) {
  return {
    outline: (cx, cy, w, h) => polygonPath(points(cx, cy, w, h)),
    intersect: (cx, cy, w, h, angle) =>
      intersectPolygon(cx, cy, points(cx, cy, w, h), angle) || intersectRect(cx, cy, w, h, angle),
    fit,
  };
}

/**
 * @typedef {Object} ShapeDef
 * @property {(cx: number, cy: number, w: number, h: number) => string} outline the `d` string
 * @property {(cx: number, cy: number, w: number, h: number, angle: number) => {x: number, y: number}} intersect
 * @property {(labelW: number, labelH: number) => {w: number, h: number}} fit
 *   smallest node box whose interior contains a `labelW` x `labelH` rectangle
 */

/**
 * Every flowchart shape, keyed by the name `flowchart/parse.js` produces.
 *
 * `intersect` is what makes arrowheads land on the border rather than somewhere near it.
 * Approximating a diamond or a circle by its bounding box leaves a visible gap at the
 * corners -- up to a quarter of the node's width for a diamond -- which reads as a bug
 * long before anyone works out what it is.
 *
 * @type {Readonly<Record<string, ShapeDef>>}
 */
export const SHAPES = Object.freeze({
  rect: {
    outline: (cx, cy, w, h) => roundedRectPath(cx, cy, w, h, 0),
    intersect: intersectRect,
    fit: (lw, lh) => ({ w: lw, h: lh }),
  },

  round: {
    outline: (cx, cy, w, h) => roundedRectPath(cx, cy, w, h, ROUND_RADIUS),
    intersect: (cx, cy, w, h, angle) =>
      intersectRoundedRect(cx, cy, w, h, angle, clampRadius(ROUND_RADIUS, w / 2, h / 2)),
    // Growing by 2r(1 - 1/sqrt2) puts the label's corner exactly on the corner arc.
    fit: (lw, lh) => {
      const bite = 2 * ROUND_RADIUS * (1 - Math.SQRT1_2);
      return { w: lw + bite, h: lh + bite };
    },
  },

  stadium: {
    outline: (cx, cy, w, h) => roundedRectPath(cx, cy, w, h, h / 2),
    intersect: (cx, cy, w, h, angle) =>
      intersectRoundedRect(cx, cy, w, h, angle, clampRadius(h / 2, w / 2, h / 2)),
    // A full-height label clears the semicircular caps only past the straight section, so
    // the caps cost their own diameter -- which is the node height -- in width.
    fit: (lw, lh) => ({ w: lw + lh, h: lh }),
  },

  subroutine: {
    outline: (cx, cy, w, h) => {
      const inset = Math.min(SUBROUTINE_INSET, w / 4);
      const l = cx - w / 2;
      const r = cx + w / 2;
      const t = cy - h / 2;
      const b = cy + h / 2;
      return path([
        ['M', l, t], ['H', r], ['V', b], ['H', l], ['Z'],
        ['M', l + inset, t], ['V', b],
        ['M', r - inset, t], ['V', b],
      ]);
    },
    intersect: intersectRect,
    fit: (lw, lh) => ({ w: lw + 2 * SUBROUTINE_INSET, h: lh }),
  },

  cylinder: {
    outline: (cx, cy, w, h) => {
      const hw = w / 2;
      const ry = cylinderRy(h);
      const l = cx - hw;
      const r = cx + hw;
      const top = cy - h / 2 + ry;
      const bottom = cy + h / 2 - ry;
      return path([
        // Body: over the top cap, down the right, under the bottom cap, closed up the left.
        ['M', l, top],
        ['A', hw, ry, 0, 0, 1, r, top],
        ['V', bottom],
        ['A', hw, ry, 0, 0, 1, l, bottom],
        ['Z'],
        // The near edge of the top cap, which is what makes it read as a cylinder.
        ['M', l, top],
        ['A', hw, ry, 0, 0, 0, r, top],
      ]);
    },
    intersect: (cx, cy, w, h, angle) => {
      const hw = w / 2;
      const hh = h / 2;
      const ry = cylinderRy(h);
      const straight = hh - ry;      // half-height of the vertical sides
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let best = Infinity;

      if (Math.abs(dx) > EPS) {
        const t = hw / Math.abs(dx);
        if (Math.abs(dy * t) <= straight + 1e-9) best = Math.min(best, t);
      }
      // Caps: the outer half of each end ellipse.
      for (const sign of [-1, 1]) {
        const roots = rayEllipseRoots(0, -sign * straight, dx, dy, hw, ry);
        for (const t of roots) {
          if (t <= 1e-9 || t >= best) continue;
          const y = dy * t;
          if (sign < 0 ? y <= -straight + 1e-9 : y >= straight - 1e-9) best = t;
        }
      }

      if (!Number.isFinite(best)) return intersectRect(cx, cy, w, h, angle);
      return { x: cx + dx * best, y: cy + dy * best };
    },
    // The cap radius depends on the height it is helping to determine, so settle it by
    // iteration. The recurrence contracts by at most 0.7 per step, so this lands within a
    // small fraction of a pixel of the true fixed point -- and stopping early leaves the
    // label sitting *inside* the cap where the outline has already started to curve away.
    fit: (lw, lh) => {
      let h = lh;
      for (let i = 0; i < 24; i += 1) h = lh + 2 * cylinderRy(h);
      return { w: lw, h };
    },
  },

  circle: {
    outline: (cx, cy, w, h) => {
      const hw = w / 2;
      const hh = h / 2;
      return path([
        ['M', cx - hw, cy],
        ['A', hw, hh, 0, 0, 1, cx + hw, cy],
        ['A', hw, hh, 0, 0, 1, cx - hw, cy],
        ['Z'],
      ]);
    },
    intersect: intersectEllipse,
    // A rectangle inscribed in an ellipse needs the ellipse to be sqrt(2) times its size.
    fit: (lw, lh) => ({ w: lw * Math.SQRT2, h: lh * Math.SQRT2 }),
  },

  // A centred rectangle fits a diamond exactly when lw/w + lh/h <= 1, hence the doubling.
  diamond: polygonShape(diamondPoints, (lw, lh) => ({ w: lw * 2, h: lh * 2 })),

  hexagon: polygonShape(hexagonPoints, (lw, lh) => ({ w: lw + 2 * lh * HEXAGON_SLANT, h: lh })),

  parallelogram: polygonShape(
    parallelogramPoints,
    (lw, lh) => ({ w: lw + 2 * lh * PARALLELOGRAM_SLANT, h: lh }),
  ),

  'parallelogram-alt': polygonShape(
    parallelogramAltPoints,
    (lw, lh) => ({ w: lw + 2 * lh * PARALLELOGRAM_SLANT, h: lh }),
  ),

  // The notch bites into the left only, but the label stays centred, so both sides pay.
  flag: polygonShape(flagPoints, (lw, lh) => ({ w: lw + 2 * lh * FLAG_NOTCH, h: lh })),
});

/**
 * @param {string} shape
 * @returns {ShapeDef}
 */
function shapeDef(shape) {
  return SHAPES[shape] || SHAPES[DEFAULT_SHAPE];
}

/**
 * Clamp a node box to something the geometry can work with. A zero-width node would make
 * every intersection degenerate, and a malformed diagram is exactly where that happens.
 * @param {number} w
 * @param {number} h
 * @returns {{w: number, h: number}}
 */
function sane(w, h) {
  return {
    w: Number.isFinite(w) && w > 1 ? w : 1,
    h: Number.isFinite(h) && h > 1 ? h : 1,
  };
}

/**
 * The outline of one node, plus the function that lands an arrowhead on it.
 *
 * @param {string} shape one of the {@link SHAPES} keys; unknown names fall back to `rect`
 * @param {number} cx centre
 * @param {number} cy centre
 * @param {number} w
 * @param {number} h
 * @returns {{ d: string,
 *   intersect: (cx: number, cy: number, w: number, h: number, angle: number) => {x: number, y: number} }}
 */
export function shapeOutline(shape, cx, cy, w, h) {
  const def = shapeDef(shape);
  const size = sane(w, h);
  return { d: def.outline(cx, cy, size.w, size.h), intersect: def.intersect };
}

/**
 * Point where a ray leaving a node's centre crosses that node's outline.
 *
 * @param {string} shape
 * @param {number} cx centre
 * @param {number} cy centre
 * @param {number} w
 * @param {number} h
 * @param {number} angle radians, 0 = right, +PI/2 = down
 * @returns {{x: number, y: number}}
 */
export function shapeIntersect(shape, cx, cy, w, h, angle) {
  const size = sane(w, h);
  return shapeDef(shape).intersect(cx, cy, size.w, size.h, angle);
}

/**
 * {@link shapeIntersect} aimed at a point instead of an angle -- the form edge routing
 * actually wants, since it knows where the next bend is, not what angle that implies.
 *
 * @param {string} shape
 * @param {number} cx centre
 * @param {number} cy centre
 * @param {number} w
 * @param {number} h
 * @param {{x: number, y: number}} target
 * @returns {{x: number, y: number}}
 */
export function shapeIntersectToward(shape, cx, cy, w, h, target) {
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return { x: cx, y: cy };
  return shapeIntersect(shape, cx, cy, w, h, Math.atan2(dy, dx));
}

/**
 * Smallest node box whose interior contains a `labelW` x `labelH` rectangle in this shape.
 *
 * Sizing a diamond or a circle from its label without this is the classic mermaid look:
 * text poking through the border on both sides. Layout still adds its own padding on top.
 *
 * @param {string} shape
 * @param {number} labelW
 * @param {number} labelH
 * @returns {{w: number, h: number}}
 */
export function shapeFit(shape, labelW, labelH) {
  const lw = Math.max(0, Number(labelW) || 0);
  const lh = Math.max(0, Number(labelH) || 0);
  const fitted = shapeDef(shape).fit(lw, lh);
  return { w: Math.max(lw, fitted.w), h: Math.max(lh, fitted.h) };
}
