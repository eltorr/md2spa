/**
 * Sequence-diagram SVG emitter.
 *
 * Same bargain as the flowchart emitter: the positioned model owns every coordinate, this
 * module owns markup, and colour lives in `style.css` so a diagram inherits the reader's
 * theme. `sequence/layout.js` hands over `TextBlock`s that already carry a first-line
 * baseline, so nothing here has to guess where text sits -- which is exactly the property
 * that keeps Safari and Chromium drawing the same picture.
 *
 * @module markdown/mermaid/render/sequence
 */

import { escapeHtml } from '../../../util/html.js';
import { el, roundedPolyline, textElement } from '../svg.js';
import { DEFAULT_FONT_SIZE, LINE_HEIGHT, measureText } from '../text.js';

/** Matches `flowchart/render` and `sequence/layout.js`; see the note there. */
const BASELINE_RATIO = 0.34;

/** Corner radius of a self-message loop, and of the boxes drawn here. */
const SELF_R = 6;
const BOX_R = 3;

/** Fallback self-loop geometry, for a model that supplies no `points`. */
const SELF_W = 44;
const SELF_H = 30;

/** Gap between a message line and the label above it, when the label is unplaced. */
const LABEL_GAP = 5;

/** Padding around a label plate this module has to size itself. Matches `LABEL_PLATE_PAD`. */
const PLATE_PAD = 4;

/**
 * Gap between a frame's tab and the branch title beside it. Matches `BLOCK_PAD` in
 * `sequence/layout.js`, which sizes every frame as `tab + title + BLOCK_PAD * 2` -- the title
 * is reserved space immediately right of the tab, so that is where it has to be drawn.
 * Centring it in the frame instead drops it on whichever lifeline happens to sit at the
 * midpoint, and disagrees with the `else`/`and` captions, which are already tab-aligned.
 */
const BLOCK_LABEL_GAP = 8;

/** Backstops against a corrupt model; `index.js` enforces the real limits. */
const MAX_ITEMS = 2000;
const MAX_LINES = 1000;

const SUMMARY_ITEMS = 12;
const SUMMARY_CHARS = 40;

/**
 * Arrow tokens exactly as an author writes them. `sequence/parse.js` normalises these into
 * `{ line, head }` before they get here, but accepting the raw form keeps this module usable
 * against a hand-built model -- which is how its tests drive it.
 */
const RAW_ARROWS = Object.freeze({
  '->': { line: 'solid', head: 'open' },
  '->>': { line: 'solid', head: 'filled' },
  '-->': { line: 'dotted', head: 'open' },
  '-->>': { line: 'dotted', head: 'filled' },
  '-)': { line: 'solid', head: 'async' },
  '--)': { line: 'dotted', head: 'async' },
  '-x': { line: 'solid', head: 'cross' },
  '--x': { line: 'dotted', head: 'cross' },
});

/**
 * Arrowhead name -> marker id suffix. `async` shares the open head deliberately: mermaid
 * draws both as a bare barb, and the `dg-message--async` class is there for a stylesheet that
 * wants to tell them apart.
 */
const HEAD_MARKERS = Object.freeze({
  filled: 'arrow', open: 'open', async: 'open', cross: 'cross',
});

const MARKER_DEFS = Object.freeze({
  arrow: (id) => marker(id, 'arrow', 10, el('path', { class: 'dg-marker__shape', d: 'M 0 0 L 10 5 L 0 10 Z' })),
  open: (id) => marker(id, 'open', 10, el('path', { class: 'dg-marker__shape', d: 'M 1 1 L 10 5 L 1 9' })),
  cross: (id) => marker(id, 'cross', 8, el('path', { class: 'dg-marker__shape', d: 'M 2 2 L 8 8 M 8 2 L 2 8' })),
});

/** Fixed emission order keeps two builds byte-identical. */
const MARKER_ORDER = ['arrow', 'open', 'cross'];

/**
 * @typedef {Object} SeqRenderContext
 * @property {string} [idPrefix] per-diagram id namespace, e.g. `'d2'`
 * @property {number} [fontSize] px; defaults to the model's own `metrics.fontSize`
 * @property {number} [lineHeight] multiplier, not px
 * @property {string} [title] overrides `model.title`
 * @property {string} [desc] overrides the generated `<desc>`
 * @property {string} [ariaLabel] overrides the generated `aria-label`
 */

/**
 * Render a positioned sequence diagram as a complete `<figure>` element.
 *
 * Coordinate conventions, matching `sequence/layout.js`: an activation, note or block frame
 * gives `x`/`y` as its **top-left** corner. A participant's column comes from its `cx` or,
 * failing that, from the lifeline carrying its id -- the box is then centred on it, so the
 * renderer does not have to know whether a bare `x` meant the box's left edge or its middle.
 *
 * @param {import('../sequence/layout.js').PositionedSequence} positioned
 * @param {SeqRenderContext} [ctx]
 * @returns {string} `<figure class="diagram diagram--sequence">…</figure>`
 */
export function renderSequenceSvg(positioned, ctx = {}) {
  const model = positioned || {};
  const participants = capped(model.participants);
  const footers = capped(model.footers);
  const activations = capped(model.activations);
  const messages = capped(model.messages);
  const notes = capped(model.notes);
  const blocks = capped(model.blocks);

  const font = positive(ctx.fontSize, positive(model.metrics?.fontSize, DEFAULT_FONT_SIZE));
  // `ctx.lineHeight` is a multiplier for consistency with the flowchart renderer, while the
  // model's `metrics.lineHeight` is already an absolute advance in px.
  const lineStep = Number.isFinite(ctx.lineHeight) && ctx.lineHeight > 0
    ? font * ctx.lineHeight
    : positive(model.metrics?.lineHeight, font * LINE_HEIGHT);
  const prefix = idPrefixOf(ctx.idPrefix);
  const text = { font, lineStep };

  // No margin is added here: `sequence/layout.js` already insets its content by `MARGIN`, and
  // §7 pins `viewBox="0 0 W H"`, so a second inset would only push the drawing off centre.
  const width = Math.max(1, Math.ceil(positive(model.width, 1)));
  const height = Math.max(1, Math.ceil(positive(model.height, 1)));

  const lifelines = Array.isArray(model.lifelines) && model.lifelines.length
    ? capped(model.lifelines)
    : deriveLifelines(participants, positive(model.height, 1));

  // The lifeline is the source of truth for where a column sits, which sidesteps the one
  // genuinely ambiguous field in the model: a participant's `x` is its box's left edge when
  // `cx` accompanies it, and the lifeline itself when it does not.
  /** @type {Map<string, number>} */
  const columns = new Map();
  for (const line of lifelines) {
    if (line && line.id !== undefined && !columns.has(String(line.id))) {
      columns.set(String(line.id), number(line.x));
    }
  }

  /** @type {Set<string>} */
  const used = new Set();
  const blockMarkup = blocks.map((block) => renderBlock(block, text));
  const lifelineMarkup = lifelines.map((line) => el('line', {
    class: 'dg-lifeline', x1: number(line?.x), y1: number(line?.y1), x2: number(line?.x), y2: number(line?.y2),
  }));
  const activationMarkup = activations.map(renderActivation);
  const messageMarkup = messages.map((message) => renderMessage(message, { ...text, prefix, used }));
  const noteMarkup = notes.map((note) => renderNote(note, text));
  const participantMarkup = participants.map((p) => renderParticipant(p, text, columns, null))
    .concat(footers.map((p) => renderParticipant(p, text, columns, 'dg-participant--repeat')))
    .concat(repeatedFooters(participants, text, columns));

  const defs = MARKER_ORDER
    .filter((name) => used.has(name))
    .map((name) => MARKER_DEFS[name](`${prefix}-${name}`))
    .join('');

  const names = participants.map((p) => firstLine(p?.text?.lines ?? p?.label) || String(p?.id ?? ''));
  const summary = summarise(names);
  const title = String(ctx.title ?? model.title ?? 'Sequence diagram');
  const desc = String(ctx.desc ?? describe(participants.length, messages.length, summary));
  const ariaLabel = String(ctx.ariaLabel
    ?? (summary ? `Sequence diagram: ${summary}` : 'Sequence diagram'));

  // Paint order is stacking order: frames sit behind everything, activations ride their
  // lifelines, notes cover the lifelines they are drawn over, and the participant boxes cap
  // the columns they own.
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
    blockMarkup.length ? el('g', { class: 'dg-blocks' }, blockMarkup) : '',
    el('g', { class: 'dg-lifelines' }, lifelineMarkup),
    activationMarkup.length ? el('g', { class: 'dg-activations' }, activationMarkup) : '',
    el('g', { class: 'dg-messages' }, messageMarkup),
    noteMarkup.length ? el('g', { class: 'dg-notes' }, noteMarkup) : '',
    el('g', { class: 'dg-participants' }, participantMarkup),
  ]);

  return el('figure', {
    class: 'diagram diagram--sequence',
    role: 'img',
    'aria-label': ariaLabel,
  }, svg);
}

/**
 * A lifeline runs from the foot of the header box to the top of the repeated footer, or to
 * the foot of the diagram when the header is not repeated. Only used for a model that does
 * not supply its own lifelines.
 * @param {Array<object>} participants
 * @param {number} height
 * @returns {Array<{ x: number, y1: number, y2: number }>}
 */
function deriveLifelines(participants, height) {
  return participants.map((p) => ({
    x: Number.isFinite(p?.cx) ? number(p.cx) : number(p?.x),
    y1: number(p?.y) + Math.max(0, number(p?.h)),
    y2: Number.isFinite(p?.bottomY) ? number(p.bottomY) : height,
  }));
}

/**
 * @param {object} participant
 * @param {{ font: number, lineStep: number }} text
 * @param {Map<string, number>} columns lifeline x by participant id
 * @param {string|null} extraClass
 * @param {number} [atY] overrides the box top, for a repeated footer
 * @returns {string}
 */
function renderParticipant(participant, text, columns, extraClass, atY) {
  const w = Math.max(1, number(participant?.w));
  const h = Math.max(1, number(participant?.h));
  const cx = columnOf(participant, columns);
  const top = Number.isFinite(atY) ? Number(atY) : number(participant?.y);
  const classes = ['dg-participant'];
  if (participant?.kind === 'actor' || participant?.actor === true) classes.push('dg-participant--actor');
  if (extraClass) classes.push(extraClass);

  return el('g', { class: classes.join(' ') }, [
    el('rect', { class: 'dg-participant__box', x: cx - w / 2, y: top, width: w, height: h, rx: BOX_R }),
    label('dg-participant__label', participant?.text, participant?.label, {
      x: cx, cy: top + h / 2, anchor: 'middle', ...text,
    }),
  ]);
}

/**
 * A tall diagram repeats its header at the foot. The layout may express that as a separate
 * `footers` array or as a `bottomY` on the participant itself; this covers the second form.
 *
 * @param {Array<object>} participants
 * @param {{ font: number, lineStep: number }} text
 * @param {Map<string, number>} columns
 * @returns {string[]}
 */
function repeatedFooters(participants, text, columns) {
  /** @type {string[]} */
  const out = [];
  for (const p of participants) {
    if (!Number.isFinite(p?.bottomY)) continue;
    out.push(renderParticipant(p, text, columns, 'dg-participant--repeat', Number(p.bottomY)));
  }
  return out;
}

/**
 * @param {object} participant
 * @param {Map<string, number>} columns
 * @returns {number} the x of the participant's lifeline
 */
function columnOf(participant, columns) {
  if (Number.isFinite(participant?.cx)) return number(participant.cx);
  const id = participant?.id === undefined ? null : String(participant.id);
  if (id !== null && columns.has(id)) return /** @type {number} */ (columns.get(id));
  return number(participant?.x);
}

/**
 * @param {object} activation
 * @returns {string}
 */
function renderActivation(activation) {
  return el('rect', {
    class: 'dg-activation',
    'data-level': String(Math.max(0, Math.trunc(number(activation?.level)))),
    x: number(activation?.x),
    y: number(activation?.y),
    width: Math.max(1, number(activation?.w)),
    height: Math.max(1, number(activation?.h)),
  });
}

/**
 * @param {object} message
 * @param {{ font: number, lineStep: number, prefix: string, used: Set<string> }} opts
 * @returns {string}
 */
function renderMessage(message, { font, lineStep, prefix, used }) {
  const arrow = arrowOf(message);
  const head = arrow.head ? HEAD_MARKERS[arrow.head] : null;
  if (head) used.add(head);

  const dir = directionOf(message);
  const self = dir === 'self';
  const points = pointsOf(message, self);

  const classes = ['dg-message', `dg-message--${arrow.line}`, `dg-message--${dir}`];
  if (arrow.head) classes.push(`dg-message--${arrow.head}`);

  const line = el('path', {
    class: 'dg-message__line',
    d: roundedPolyline(points, self ? SELF_R : 0),
    'marker-end': head ? `url(#${prefix}-${head})` : null,
  });

  const placed = message?.labelPos
    && Number.isFinite(message.labelPos.x) && Number.isFinite(message.labelPos.y)
    ? { x: number(message.labelPos.x), cy: number(message.labelPos.y), anchor: self ? 'start' : 'middle' }
    : defaultLabelPos(points, self, toLines(message?.label).length, lineStep);
  const resolved = resolveLabel(message?.text, message?.label, { ...placed, font, lineStep });

  return el('g', {
    class: classes.join(' '),
    'data-number': Number.isFinite(message?.number) ? String(message.number) : null,
  }, [line, plateFor(message?.plate, resolved, font), drawLabel('dg-message__label', resolved)]);
}

/**
 * The plate behind a message label.
 *
 * A message spanning three or more participants passes over the lifelines in between, and
 * without the plate those hairlines are drawn straight through the text. The layout usually
 * sizes it; when it does not, it is sized here from the same metrics the layout would use.
 *
 * @param {unknown} explicit a `{x, y, w, h}` rect from the layout, or nullish
 * @param {ReturnType<typeof resolveLabel>} resolved
 * @param {number} font
 * @returns {string}
 */
function plateFor(explicit, resolved, font, cls = 'dg-message__label-bg dg-edge__label-bg') {
  const rect = explicit && typeof explicit === 'object'
    && Number.isFinite(/** @type {any} */ (explicit).w)
    ? /** @type {any} */ (explicit)
    : null;

  if (rect) {
    return el('rect', {
      class: cls,
      x: number(rect.x),
      y: number(rect.y),
      width: Math.max(0, number(rect.w)),
      height: Math.max(0, number(rect.h)),
      rx: BOX_R,
    });
  }
  if (!resolved) return '';

  let widest = 0;
  for (const line of resolved.lines) widest = Math.max(widest, widthOf(line, font));
  const w = widest + PLATE_PAD * 2;
  const h = resolved.lines.length * resolved.step + PLATE_PAD;
  const cy = resolved.baseline + ((resolved.lines.length - 1) * resolved.step) / 2 - font * BASELINE_RATIO;
  const x = resolved.anchor === 'start'
    ? resolved.x - PLATE_PAD
    : (resolved.anchor === 'end' ? resolved.x - w + PLATE_PAD : resolved.x - w / 2);

  return el('rect', { class: cls, x, y: cy - h / 2, width: w, height: h, rx: BOX_R });
}

/**
 * @param {string} text
 * @param {number} font
 * @returns {number}
 */
function widthOf(text, font) {
  try {
    const measured = measureText(text, { size: font });
    if (measured && Number.isFinite(measured.width)) return measured.width;
  } catch {
    // A metrics failure must not cost the diagram; an approximate plate is fine.
  }
  return [...String(text)].length * font * 0.62;
}

/**
 * Where a label goes when the model carries no placed `TextBlock`: beside the loop for a
 * self-message, otherwise centred just above the line.
 * @param {Array<{x: number, y: number}>} points
 * @param {boolean} self
 * @param {number} lineCount
 * @param {number} lineStep
 * @returns {{ x: number, cy: number, anchor: 'start'|'middle' }}
 */
function defaultLabelPos(points, self, lineCount, lineStep) {
  const first = points[0] || { x: 0, y: 0 };
  const last = points[points.length - 1] || first;
  if (self) {
    const right = points.reduce((max, p) => Math.max(max, number(p?.x)), first.x);
    const top = points.reduce((min, p) => Math.min(min, number(p?.y)), first.y);
    const bottom = points.reduce((max, p) => Math.max(max, number(p?.y)), first.y);
    return { x: right + LABEL_GAP + 3, cy: (top + bottom) / 2, anchor: 'start' };
  }
  return {
    x: (number(first.x) + number(last.x)) / 2,
    cy: number(first.y) - LABEL_GAP - (Math.max(1, lineCount) * lineStep) / 2,
    anchor: 'middle',
  };
}

/**
 * @param {object} note
 * @param {{ font: number, lineStep: number }} text
 * @returns {string}
 */
function renderNote(note, text) {
  const x = number(note?.x);
  const y = number(note?.y);
  const w = Math.max(1, number(note?.w));
  const h = Math.max(1, number(note?.h));
  return el('g', { class: `dg-note dg-note--${notePlacement(note?.placement)}` }, [
    el('rect', { class: 'dg-note__box', x, y, width: w, height: h, rx: BOX_R }),
    label('dg-note__label', note?.text, note?.label, {
      x: x + w / 2, cy: y + h / 2, anchor: 'middle', ...text,
    }),
  ]);
}

/**
 * A block frame: the box, the folded tab naming the construct, the block's own caption, and a
 * dashed divider for every `else` / `and` branch.
 * @param {object} block
 * @param {{ font: number, lineStep: number }} text
 * @returns {string}
 */
function renderBlock(block, text) {
  const x = number(block?.x);
  const y = number(block?.y);
  const w = Math.max(1, number(block?.w));
  const h = Math.max(1, number(block?.h));
  const keyword = slug(block?.keyword ?? block?.kind) || 'loop';
  const depth = Math.max(0, Math.trunc(number(block?.depth)));

  const tab = block?.tab || {};
  const tabW = Math.max(1, positive(tab.w, 34));
  const tabH = Math.max(1, positive(tab.h, 18));
  const tabX = Number.isFinite(tab.x) ? number(tab.x) : x;
  const tabY = Number.isFinite(tab.y) ? number(tab.y) : y;
  const notch = Math.min(6, tabW / 2, tabH / 2);

  const dividers = (Array.isArray(block?.dividers) ? block.dividers : []).slice(0, MAX_ITEMS);
  const dividerMarkup = dividers.map((divider) => {
    const dy = number(divider?.y);
    return el('line', {
      class: 'dg-block__divider',
      x1: Number.isFinite(divider?.x1) ? number(divider.x1) : x,
      y1: dy,
      x2: Number.isFinite(divider?.x2) ? number(divider.x2) : x + w,
      y2: dy,
    }) + platedLabel('dg-block__label dg-block__label--divider', divider?.text, divider?.label, {
      x: x + notch, cy: dy + text.lineStep, anchor: 'start', ...text,
    });
  });

  return el('g', { class: `dg-block dg-block--${keyword}`, 'data-depth': String(depth) }, [
    el('rect', { class: 'dg-block__frame', x, y, width: w, height: h, rx: BOX_R }),
    el('path', {
      class: 'dg-block__tab',
      d: `M ${fmt(tabX)} ${fmt(tabY)} L ${fmt(tabX + tabW)} ${fmt(tabY)}`
        + ` L ${fmt(tabX + tabW)} ${fmt(tabY + tabH - notch)} L ${fmt(tabX + tabW - notch)} ${fmt(tabY + tabH)}`
        + ` L ${fmt(tabX)} ${fmt(tabY + tabH)} Z`,
    }),
    label('dg-block__label dg-block__label--kind', tab.text, keyword, {
      x: tabX + tabW / 2, cy: tabY + tabH / 2, anchor: 'middle', ...text,
    }),
    platedLabel('dg-block__label', block?.text, block?.label, {
      x: tabX + tabW + BLOCK_LABEL_GAP, cy: tabY + tabH / 2, anchor: 'start', ...text,
    }),
    dividerMarkup.join(''),
  ]);
}

/**
 * Draw a label from a placed `TextBlock` when the layout supplied one, and fall back to
 * centring raw lines on `geom` when it did not.
 *
 * @param {string} cls
 * @param {unknown} block a `TextBlock` from `sequence/layout.js`, or nullish
 * @param {unknown} fallbackLines raw lines to use when `block` is absent
 * @param {{ x: number, cy: number, anchor: 'start'|'middle'|'end',
 *           font: number, lineStep: number }} geom
 * @returns {string}
 */
function label(cls, block, fallbackLines, geom) {
  return drawLabel(cls, resolveLabel(block, fallbackLines, geom));
}

/**
 * A label with a background plate behind it.
 *
 * Block captions (`alt no errors`, `else fail`) are positioned by the frame, not by the
 * participants, so they routinely land on top of a lifeline that has nothing to do with
 * them. Messages already solve this with a plate; frames need the same treatment.
 *
 * @param {string} cls
 * @param {unknown} block
 * @param {unknown} fallbackLines
 * @param {{ x: number, cy: number, anchor: 'start'|'middle'|'end',
 *           font: number, lineStep: number }} geom
 * @returns {string}
 */
function platedLabel(cls, block, fallbackLines, geom) {
  const resolved = resolveLabel(block, fallbackLines, geom);
  if (!resolved) return '';
  return plateFor(null, resolved, geom.font, 'dg-block__label-bg dg-edge__label-bg')
    + drawLabel(cls, resolved);
}

/**
 * Settle a label's geometry once, so the text and the plate behind it cannot disagree.
 *
 * @param {unknown} block a `TextBlock` from `sequence/layout.js`, or nullish
 * @param {unknown} fallbackLines raw lines to use when `block` is absent
 * @param {{ x: number, cy: number, anchor: 'start'|'middle'|'end',
 *           font: number, lineStep: number }} geom
 * @returns {{ lines: string[], x: number, baseline: number, anchor: string, step: number }|null}
 */
function resolveLabel(block, fallbackLines, geom) {
  const placed = /** @type {any} */ (block);
  if (placed && Array.isArray(placed.lines) && placed.lines.length) {
    return {
      lines: placed.lines.slice(0, MAX_LINES).map((line) => String(line ?? '')),
      x: number(placed.x),
      baseline: number(placed.y),
      anchor: placed.anchor || geom.anchor,
      step: positive(placed.lineHeight, geom.lineStep),
    };
  }
  const lines = toLines(fallbackLines);
  if (lines.length === 0) return null;
  return {
    lines,
    x: geom.x,
    baseline: geom.cy - ((lines.length - 1) * geom.lineStep) / 2 + geom.font * BASELINE_RATIO,
    anchor: geom.anchor,
    step: geom.lineStep,
  };
}

/**
 * @param {string} cls
 * @param {ReturnType<typeof resolveLabel>} resolved
 * @returns {string}
 */
function drawLabel(cls, resolved) {
  if (!resolved) return '';
  return textElement(resolved.lines, {
    x: resolved.x,
    y: resolved.baseline,
    className: cls,
    lineHeight: resolved.step,
    anchor: resolved.anchor,
  });
}

/**
 * Resolve a message's line style and arrowhead from the normalised `arrow` object, an author's
 * raw token, or a loose kind string.
 * @param {object} message
 * @returns {{ line: 'solid'|'dotted', head: string|null }}
 */
function arrowOf(message) {
  const arrow = message?.arrow;
  if (arrow && typeof arrow === 'object') {
    return {
      line: arrow.line === 'dotted' ? 'dotted' : 'solid',
      head: typeof arrow.head === 'string' && HEAD_MARKERS[arrow.head] ? arrow.head : 'filled',
    };
  }

  const raw = String(message?.kind ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(RAW_ARROWS, raw)) return { ...RAW_ARROWS[raw] };

  const k = raw.toLowerCase();
  const line = message?.dashed === true || /dash|dotted/.test(k) || raw.startsWith('--')
    ? 'dotted'
    : 'solid';
  let head = 'filled';
  if (/cross|(^|[-_])x$/.test(k)) head = 'cross';
  else if (/async|\)/.test(k)) head = 'async';
  else if (/open/.test(k)) head = 'open';
  else if (/none|plain/.test(k)) head = null;
  return { line, head };
}

/**
 * @param {object} message
 * @returns {'ltr'|'rtl'|'self'}
 */
function directionOf(message) {
  const dir = message?.dir;
  if (dir === 'ltr' || dir === 'rtl' || dir === 'self') return dir;
  if (message?.self === true) return 'self';
  const points = Array.isArray(message?.points) ? message.points : null;
  const from = points ? number(points[0]?.x) : number(message?.x1);
  const to = points ? number(points[points.length - 1]?.x) : number(message?.x2 ?? message?.x1);
  if (Math.abs(to - from) < 0.5) return 'self';
  return to > from ? 'ltr' : 'rtl';
}

/**
 * @param {object} message
 * @param {boolean} self
 * @returns {Array<{x: number, y: number}>}
 */
function pointsOf(message, self) {
  if (Array.isArray(message?.points) && message.points.length >= 2) {
    return message.points.slice(0, MAX_ITEMS);
  }
  const x1 = number(message?.x1);
  const y = number(message?.y);
  if (self) {
    const w = positive(message?.selfWidth, SELF_W);
    const h = positive(message?.height, SELF_H);
    return [{ x: x1, y }, { x: x1 + w, y }, { x: x1 + w, y: y + h }, { x: x1, y: y + h }];
  }
  return [{ x: x1, y }, { x: number(message?.x2 ?? x1), y }];
}

/**
 * `Note left of A` and `Note right of A` arrive as the author wrote them; the class contract
 * wants the side, not the phrase.
 * @param {unknown} placement
 * @returns {'left'|'right'|'over'}
 */
function notePlacement(placement) {
  const value = slug(placement);
  if (value.startsWith('left')) return 'left';
  if (value.startsWith('right')) return 'right';
  return 'over';
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
 * @param {unknown} value `string[]`, a raw string, or nothing
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
 * Numbers for strings `el()` does not format for us -- the viewBox and the tab path.
 * @param {number} value
 * @returns {string}
 */
function fmt(value) {
  return String(Math.round(number(value) * 1000) / 1000 || 0);
}

/**
 * @param {string[]} names
 * @returns {string}
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
 * @param {number} participantCount
 * @param {number} messageCount
 * @param {string} summary
 * @returns {string}
 */
function describe(participantCount, messageCount, summary) {
  const head = `Sequence diagram with ${participantCount} ${plural(participantCount, 'participant')}`
    + ` and ${messageCount} ${plural(messageCount, 'message')}`;
  return summary ? `${head}: ${summary}.` : `${head}.`;
}

/** @param {number} count @param {string} word @returns {string} */
function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}
