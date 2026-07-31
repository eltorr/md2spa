/**
 * Flowchart SVG emitter -- the last stage of the mermaid pipeline.
 *
 * Everything here is markup. The positioned model owns every coordinate, and the shapes come
 * from `../svg.js`, which is the same module the layout asked for edge/outline intersections:
 * drawing a diamond here that differs by a pixel from the diamond layout aimed at would leave
 * every arrowhead floating just off its border, which reads as a bug long before anyone works
 * out why.
 *
 * The emitted SVG carries **classes and geometry only**. Colour, stroke width and font come
 * from `style.css`, which is what lets a diagram follow the reader's theme and lets a user
 * retheme diagrams without patching this file. The one concession is `text-anchor`, a
 * presentation attribute: any CSS rule beats it, so the stylesheet stays in charge while a
 * stylesheet-less render still centres its labels.
 *
 * @module markdown/mermaid/render/flowchart
 */

import { escapeHtml } from '../../../util/html.js';
import { el, roundedPolyline, shapeOutline, textElement } from '../svg.js';
import { DEFAULT_FONT_SIZE, LINE_HEIGHT, measureText } from '../text.js';

/** Breathing room between the content box and the viewBox edge -- `PositionedFlow` is the
 * content box *before* margin. */
const DEFAULT_MARGIN = 8;

/**
 * Distance from a line's optical centre down to its baseline, in em. `dominant-baseline`
 * would do this for us, but Safari and Chromium disagree once a `<text>` holds more than one
 * `<tspan>`, so every baseline is computed here. Matches `sequence/layout.js`, so labels sit
 * at the same height in both diagram types.
 */
const BASELINE_RATIO = 0.34;

/** Must match `CORNER` in `flowchart/layout.js`: the radius that module routes for. */
const CORNER = 6;

/** Padding inside an edge label's plate. Matches `EDGE_LABEL_PAD` in `flowchart/layout.js`. */
const EDGE_LABEL_PAD = 6;

/** Inset of a subgraph title from the box's left edge, and the fallback title band height. */
const SUB_TITLE_INSET = 12;
const SUB_TITLE_BAND = 22;

/** Corner radius for the boxes this module draws itself. */
const BOX_R = 6;
const PLATE_R = 3;

/**
 * Backstops. `index.js` enforces the real limits (300 nodes / 600 edges); these only stop a
 * hand-built or corrupted model from turning into an unbounded loop.
 */
const MAX_ITEMS = 4000;
const MAX_LINES = 1000;
const MAX_CLASSES = 64;

/** How much of the diagram the accessible summary spells out before it says "and N more". */
const SUMMARY_ITEMS = 12;
const SUMMARY_CHARS = 40;

/** Which marker, if any, terminates each edge kind. */
const EDGE_MARKERS = Object.freeze({
  arrow: 'arrow',
  open: null,
  dotted: 'arrow',
  thick: 'arrow',
  cross: 'cross',
  circle: 'circle',
});

/**
 * Marker bodies, keyed by the name used in {@link EDGE_MARKERS}.
 *
 * `markerUnits="userSpaceOnUse"` rather than the default `strokeWidth`: a user who raises
 * `--dg-stroke` wants heavier lines, not arrowheads twice the size. `refX` sits at the tip so
 * the head lands exactly on the point layout computed on the node's outline.
 */
const MARKER_DEFS = Object.freeze({
  arrow: (id) => marker(id, 'arrow', 10, el('path', { class: 'dg-marker__shape', d: 'M 0 0 L 10 5 L 0 10 Z' })),
  cross: (id) => marker(id, 'cross', 8, el('path', { class: 'dg-marker__shape', d: 'M 2 2 L 8 8 M 8 2 L 2 8' })),
  circle: (id) => marker(id, 'circle', 8.5, el('circle', { class: 'dg-marker__shape', cx: 5, cy: 5, r: 3.5 })),
});

/** Fixed emission order, so two builds of the same diagram produce identical bytes. */
const MARKER_ORDER = ['arrow', 'cross', 'circle'];

/**
 * @typedef {Object} FlowRenderContext
 * @property {string} [idPrefix] per-diagram id namespace, e.g. `'d1'`; keeps two diagrams on
 *   one page from sharing a `<marker>`. Deterministic, never random.
 * @property {number} [fontSize] px; must match `--dg-font-size` or labels drift from the
 *   boxes layout sized for them
 * @property {number} [lineHeight] multiplier, not px
 * @property {number} [margin] px added around the content box
 * @property {string} [title] overrides the generated `<title>`
 * @property {string} [desc] overrides the generated `<desc>`
 * @property {string} [ariaLabel] overrides the generated `aria-label`
 */

/**
 * Render a positioned flowchart as a complete `<figure>` element.
 *
 * Coordinate conventions, matching `flowchart/layout.js`: a **node**'s `x`/`y` are its
 * centre; a **subgraph**'s are its top-left corner.
 *
 * @param {import('../flowchart/layout.js').PositionedFlow} positioned
 * @param {FlowRenderContext} [ctx]
 * @returns {string} `<figure class="diagram diagram--flowchart">…</figure>`
 */
export function renderFlowchartSvg(positioned, ctx = {}) {
  const model = positioned || {};
  const nodes = capped(model.nodes);
  const edges = capped(model.edges);
  const subgraphs = capped(model.subgraphs);

  const font = positive(ctx.fontSize, DEFAULT_FONT_SIZE);
  const lineStep = font * positive(ctx.lineHeight, LINE_HEIGHT);
  const margin = Number.isFinite(ctx.margin) ? Math.max(0, ctx.margin) : DEFAULT_MARGIN;
  const prefix = idPrefixOf(ctx.idPrefix);
  // The margin is folded into every coordinate rather than carried by a negative viewBox
  // origin or a wrapper transform, so that the viewBox, the width/height attributes and the
  // content all agree on one coordinate system -- §7 pins `viewBox="0 0 W H"`.
  const text = { font, lineStep, shift: margin };

  const width = Math.max(1, Math.ceil(positive(model.width, 1) + margin * 2));
  const height = Math.max(1, Math.ceil(positive(model.height, 1) + margin * 2));

  /** @type {Set<string>} */
  const used = new Set();
  const edgeMarkup = edges.map((edge) => renderEdge(edge, { ...text, prefix, used }));
  const nodeMarkup = nodes.map((node) => renderNode(node, text));
  const subMarkup = renderSubgraphs(subgraphs, text);

  const defs = MARKER_ORDER
    .filter((name) => used.has(name))
    .map((name) => MARKER_DEFS[name](`${prefix}-${name}`))
    .join('');

  const names = nodes.map((node) => firstLine(node?.label) || String(node?.id ?? ''));
  const summary = summarise(names);
  const title = String(ctx.title ?? 'Flowchart');
  const desc = String(ctx.desc ?? describe(nodes.length, edges.length, summary));
  const ariaLabel = String(ctx.ariaLabel ?? (summary ? `Flowchart: ${summary}` : 'Flowchart'));

  const svg = el('svg', {
    class: 'diagram__svg',
    viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
    width,
    height,
    preserveAspectRatio: 'xMidYMid meet',
    xmlns: 'http://www.w3.org/2000/svg',
  }, [
    el('title', {}, escapeHtml(title)),
    el('desc', {}, escapeHtml(desc)),
    defs ? el('defs', {}, defs) : '',
    subMarkup,
    el('g', { class: 'dg-edges' }, edgeMarkup),
    el('g', { class: 'dg-nodes' }, nodeMarkup),
  ]);

  return el('figure', {
    class: 'diagram diagram--flowchart',
    role: 'img',
    'aria-label': ariaLabel,
  }, svg);
}

/**
 * Subgraph boxes paint shallowest-first so a nested box lands on top of its parent. The index
 * tiebreak makes the order a total one rather than relying on sort stability.
 *
 * @param {Array<object>} subgraphs
 * @param {{ font: number, lineStep: number, shift: number }} text
 * @returns {string}
 */
function renderSubgraphs(subgraphs, text) {
  if (subgraphs.length === 0) return '';
  const ordered = subgraphs
    .map((sub, index) => ({ sub, index, depth: Math.trunc(number(sub?.depth)) }))
    .sort((a, b) => (a.depth - b.depth) || (a.index - b.index));

  const groups = ordered.map(({ sub, depth }) => {
    const x = number(sub?.x) + text.shift;
    const y = number(sub?.y) + text.shift;
    const w = Math.max(0, number(sub?.w));
    const h = Math.max(0, number(sub?.h));
    const band = positive(sub?.titleHeight, SUB_TITLE_BAND);
    const lines = toLines(sub?.title);
    return el('g', { class: 'dg-subgraph', 'data-depth': String(Math.max(0, depth)) }, [
      el('rect', { class: 'dg-subgraph__box', x, y, width: w, height: h, rx: BOX_R }),
      lines.length
        ? label(lines, {
          cls: 'dg-subgraph__title', x: x + SUB_TITLE_INSET, cy: y + band / 2, anchor: 'start', ...text,
        })
        : '',
    ]);
  });

  return el('g', { class: 'dg-subgraphs' }, groups);
}

/**
 * @param {object} node
 * @param {{ font: number, lineStep: number, shift: number }} text
 * @returns {string}
 */
function renderNode(node, text) {
  const shape = slug(node?.shape) || 'rect';
  const x = number(node?.x) + text.shift;
  const y = number(node?.y) + text.shift;
  const w = Math.max(1, number(node?.w));
  const h = Math.max(1, number(node?.h));

  const classes = ['dg-node', `dg-node--${shape}`];
  for (const name of userClasses(node?.classes)) classes.push(`node--${name}`);

  const lines = toLines(node?.label);
  return el('g', { class: classes.join(' ') }, [
    el('path', { class: 'dg-node__shape', d: shapeOutline(shape, x, y, w, h).d }),
    lines.length
      ? label(lines, { cls: 'dg-node__label', x, cy: y, anchor: 'middle', ...text })
      : '',
  ]);
}

/**
 * @param {object} edge
 * @param {{ font: number, lineStep: number, shift: number, prefix: string,
 *           used: Set<string> }} opts
 * @returns {string}
 */
function renderEdge(edge, { font, lineStep, shift, prefix, used }) {
  const kind = slug(edge?.kind) || 'arrow';
  const head = Object.prototype.hasOwnProperty.call(EDGE_MARKERS, kind)
    ? EDGE_MARKERS[kind]
    : 'arrow';
  if (head) used.add(head);

  const line = el('path', {
    class: 'dg-edge__line',
    d: roundedPolyline(shiftPoints(edge?.points, shift), CORNER),
    'marker-end': head ? `url(#${prefix}-${head})` : null,
  });

  const lines = toLines(edge?.label);
  const pos = edge?.labelPos;
  let plate = '';
  let caption = '';
  if (lines.length && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const cx = number(pos.x) + shift;
    const cy = number(pos.y) + shift;
    // Without the plate the edge is drawn straight through its own label.
    const w = positive(edge?.labelWidth, measureWidth(lines, font)) + EDGE_LABEL_PAD * 2;
    const h = positive(edge?.labelHeight, lines.length * lineStep) + EDGE_LABEL_PAD;
    plate = el('rect', {
      class: 'dg-edge__label-bg', x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: PLATE_R,
    });
    caption = label(lines, { cls: 'dg-edge__label', x: cx, cy, anchor: 'middle', font, lineStep });
  }

  return el('g', { class: `dg-edge dg-edge--${kind}` }, [line, plate, caption]);
}

/**
 * A multi-line label centred vertically on `cy`, with the first baseline computed explicitly.
 * @param {string[]} lines
 * @param {{ cls: string, x: number, cy: number, anchor: 'start'|'middle'|'end',
 *           font: number, lineStep: number }} opts
 * @returns {string}
 */
function label(lines, { cls, x, cy, anchor, font, lineStep }) {
  return textElement(lines, {
    x,
    y: cy - ((lines.length - 1) * lineStep) / 2 + font * BASELINE_RATIO,
    className: cls,
    lineHeight: lineStep,
    anchor,
  });
}

/**
 * @param {string} id
 * @param {string} name
 * @param {number} refX where along the marker the path's end point lands
 * @param {string} body already-escaped markup
 * @returns {string}
 */
function marker(id, name, refX, body) {
  return el('marker', {
    id,
    class: `dg-marker dg-marker--${name}`,
    viewBox: '0 0 10 10',
    refX,
    refY: 5,
    markerWidth: 9,
    markerHeight: 9,
    markerUnits: 'userSpaceOnUse',
    orient: 'auto',
  }, body);
}

/**
 * Offset a routed polyline by the diagram margin, dropping anything non-finite on the way --
 * a `NaN` reaching the `d` attribute silently blanks the whole path.
 * @param {unknown} points
 * @param {number} shift
 * @returns {Array<{x: number, y: number}>}
 */
function shiftPoints(points, shift) {
  if (!Array.isArray(points)) return [];
  /** @type {Array<{x: number, y: number}>} */
  const out = [];
  const limit = Math.min(points.length, MAX_ITEMS);
  for (let i = 0; i < limit; i += 1) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    out.push({ x: p.x + shift, y: p.y + shift });
  }
  return out;
}

/**
 * Width of the widest line, for a model that carries no measured label box. Uses the same
 * metrics the layout sizes with, so a plate added here still agrees with the boxes around it.
 * @param {string[]} lines
 * @param {number} font
 * @returns {number}
 */
function measureWidth(lines, font) {
  let widest = 0;
  for (const line of lines) {
    try {
      const measured = measureText(line, { size: font });
      if (measured && Number.isFinite(measured.width)) {
        widest = Math.max(widest, measured.width);
        continue;
      }
    } catch {
      // A metrics failure must not cost the diagram; an approximate plate is fine.
    }
    widest = Math.max(widest, [...line].length * font * 0.62);
  }
  return widest;
}

/**
 * Normalise a label into lines. Accepts the `string[]` the parser produces, a raw string
 * (split on newlines) or nothing at all.
 * @param {unknown} value
 * @returns {string[]}
 */
function toLines(value) {
  const raw = Array.isArray(value) ? value : (value == null ? [] : String(value).split('\n'));
  /** @type {string[]} */
  const out = [];
  const limit = Math.min(raw.length, MAX_LINES);
  for (let i = 0; i < limit; i += 1) {
    const line = raw[i] == null ? '' : String(raw[i]);
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** @param {unknown} value @returns {string} */
function firstLine(value) {
  const lines = toLines(value);
  return lines.length ? lines[0] : '';
}

/**
 * Class names reach a CSS selector, so keep them to characters that cannot need escaping
 * there. Duplicates are dropped, order preserved.
 * @param {unknown} classes
 * @returns {string[]}
 */
function userClasses(classes) {
  if (!Array.isArray(classes)) return [];
  /** @type {string[]} */
  const out = [];
  const limit = Math.min(classes.length, MAX_CLASSES);
  for (let i = 0; i < limit; i += 1) {
    const name = slug(classes[i]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** @param {unknown} value @returns {string} */
function slug(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** @param {unknown} value @returns {string} an id fragment safe inside `url(#…)` */
function idPrefixOf(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]+/g, '') || 'd1';
}

/** @param {unknown} list @returns {Array<object>} */
function capped(list) {
  return Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [];
}

/** @param {unknown} value @returns {number} */
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Integers for the viewBox string, which `el()` does not format for us.
 * @param {number} value
 * @returns {string}
 */
function fmt(value) {
  return String(Math.round(value * 1000) / 1000 || 0);
}

/**
 * @param {string[]} names
 * @returns {string} e.g. `Start, Check, Done and 4 more`
 */
function summarise(names) {
  const cleaned = names
    .map((name) => String(name ?? '').replace(/\s+/g, ' ').trim())
    .filter((name) => name.length > 0);
  const kept = cleaned.slice(0, SUMMARY_ITEMS).map((name) => (
    name.length > SUMMARY_CHARS ? `${name.slice(0, SUMMARY_CHARS - 1)}…` : name
  ));
  if (kept.length === 0) return '';
  const extra = cleaned.length - kept.length;
  return extra > 0 ? `${kept.join(', ')} and ${extra} more` : kept.join(', ');
}

/**
 * @param {number} nodeCount
 * @param {number} edgeCount
 * @param {string} summary
 * @returns {string}
 */
function describe(nodeCount, edgeCount, summary) {
  const head = `Flowchart with ${nodeCount} ${plural(nodeCount, 'node')}`
    + ` and ${edgeCount} ${plural(edgeCount, 'connection')}`;
  return summary ? `${head}: ${summary}.` : `${head}.`;
}

/** @param {number} count @param {string} word @returns {string} */
function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}
