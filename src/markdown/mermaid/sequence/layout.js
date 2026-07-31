/**
 * Sequence diagram layout: `SequenceModel` in, absolute coordinates out.
 *
 * Two passes over the event stream. The first measures every piece of text and collects
 * *horizontal constraints*; the second walks the events top to bottom assigning rows, by
 * which time the columns are already fixed. Splitting it this way is what makes the main
 * quality requirement achievable: a message label has to be measured before the columns
 * exist, because the label is one of the things that decides how far apart they go.
 *
 * The constraint solver is the interesting part. Three kinds:
 *
 *   gap   the clear distance between two adjacent lifelines has a floor -- a side note or
 *         a self-message loop hanging off a lifeline must not reach its neighbour.
 *   span  the distance from lifeline i to lifeline j has a floor, and any shortfall is
 *         shared equally between the gaps in between -- used for `Note over A,B` and for
 *         block frames whose tab and title need room.
 *   slot  at least one adjacent pair inside i..j must be wide enough to hold a label.
 *
 * `slot` is how "messages must never overlap their neighbours' lifelines" is honoured.
 * A label is not centred on its arrow when the arrow spans several lifelines; it is placed
 * in whichever gap inside the span is closest to the arrow's midpoint *and* wide enough,
 * and only when no gap qualifies does the diagram get wider. For the common two-neighbour
 * message that rule collapses to "centre it, and widen the gap if it does not fit".
 *
 * @module markdown/mermaid/sequence/layout
 */

import { measureText, wrapText } from '../text.js';

/** Clear space between two participant boxes before any constraint widens it. */
export const PARTICIPANT_GAP = 48;
/** Baseline vertical advance per message row. */
export const MESSAGE_GAP = 40;
/** Width of an activation bar. */
export const ACTIVATION_W = 10;
/** Each nested activation on the same participant steps this far right. */
export const ACTIVATION_NEST = 4;
/** Shortest activation bar that is still visible as a bar. */
export const ACTIVATION_MIN_H = 16;
/** Inset of a nested block frame inside its parent. */
export const BLOCK_PAD = 8;
/** Past this much lifeline height the participant header is repeated at the bottom. */
export const REPEAT_HEADER_AFTER = 520;

/** Participant box padding and floors. */
export const PARTICIPANT_PAD_X = 14;
export const PARTICIPANT_PAD_Y = 9;
export const PARTICIPANT_MIN_W = 84;
export const PARTICIPANT_MIN_H = 34;

/** Clear space demanded either side of a message label inside its gap. */
export const MESSAGE_LABEL_PAD = 8;
/** Distance from the bottom of a message label to the message line. */
export const MESSAGE_LABEL_GAP = 5;
/** Clear space kept above a message label. */
export const MESSAGE_LABEL_CLEAR = 8;
/**
 * Padding the emitter puts around the plate behind a message label. Reserved here so a
 * self-message label sitting at the right edge is not clipped by the content box.
 */
export const LABEL_PLATE_PAD = 4;

/** Self-message loop: how far right it reaches and how tall it is. */
export const SELF_LOOP_W = 44;
export const SELF_LOOP_H = 30;
/** Gap between a self-message loop and its label. */
export const SELF_LABEL_GAP = 8;

/** Note box padding, the gap above/below it, and its offset from the lifeline. */
export const NOTE_PAD_X = 10;
export const NOTE_PAD_Y = 7;
export const NOTE_GAP = 10;
export const NOTE_OFFSET = 16;
/** Clear space kept between a side note and the neighbouring lifeline. */
export const NOTE_CLEAR = 8;

/** Block frame overhang beyond the outermost participant box it encloses. */
export const BLOCK_MARGIN_X = 12;
/**
 * Height of the band holding a frame's tab and title, and of a section caption. The emitter
 * draws an 18px tab into it, so this is the floor that keeps the tab off the first message.
 */
export const BLOCK_LABEL_H = 20;
/** Vertical breathing room after a frame closes. */
export const BLOCK_GAP = 12;
/**
 * Horizontal padding inside the tab, and the tab's floor. The emitter draws the tab; the
 * layout only reserves room for it, so these are sized a shade generously on purpose.
 */
export const BLOCK_TAB_PAD = 10;
export const BLOCK_TAB_MIN_W = 34;

/** Lifeline stubs above the first row and below the last. */
export const LIFELINE_TOP = 12;
export const LIFELINE_BOTTOM = 16;

/** Wrapped text is capped so a pathological label cannot produce an unbounded diagram. */
const MAX_LABEL_LINES = 40;
/** The constraint solver is monotone, so a handful of passes always converges. */
const MAX_SOLVE_PASSES = 6;
const EPS = 0.01;

/**
 * The shape below is the one `../render/sequence.js` documents and consumes. Two conventions
 * are worth stating because they differ between items: a **participant**'s `x` is its
 * lifeline, i.e. the centre of its box, while every box-shaped item -- activation, note,
 * block frame -- gives `x`/`y` as its top-left corner. Coordinates are a content box with its
 * origin at (0, 0); the emitter adds the outer margin itself.
 *
 * Text is handed over as `label: string[]` plus, where the position is not implied by the
 * box, a `labelPos` marking the *centre* of the whole block. Baselines belong to the emitter.
 */

/**
 * @typedef {Object} PositionedParticipant
 * @property {string} id
 * @property {string[]} label
 * @property {boolean} actor       drawn from `actor A` rather than `participant A`
 * @property {number} x            lifeline x, i.e. the box centre
 * @property {number} y            box top edge
 * @property {number} w
 * @property {number} h
 * @property {number|null} bottomY top of the repeated footer box, null when not repeated
 */

/**
 * @typedef {Object} PositionedMessage
 * @property {string} from
 * @property {string} to
 * @property {string} kind          the author's arrow token, e.g. `-->>`
 * @property {boolean} dashed
 * @property {boolean} self
 * @property {number} x1            where the line leaves `from`
 * @property {number} x2            where it meets `to` (equal to x1 for a self message)
 * @property {number} y             the line's y, or the top of a self loop
 * @property {number} height        self-message loop height, 0 otherwise
 * @property {number} selfWidth     how far right a self loop reaches, 0 otherwise
 * @property {Array<{x: number, y: number}>} points  2 points, or 4 around a self loop
 * @property {string[]} label
 * @property {{x: number, y: number}|null} labelPos  centre of the label block
 * @property {number|null} number   autonumber, when enabled
 */

/**
 * @typedef {Object} PositionedSequence
 * @property {number} width                          content box, before the emitter's margin
 * @property {number} height
 * @property {string|null} title
 * @property {string[]} order                        participant ids, left to right
 * @property {PositionedParticipant[]} participants
 * @property {Array<{id: string, x: number, y1: number, y2: number}>} lifelines
 * @property {Array<{participant: string, x: number, y: number, w: number, h: number,
 *                   level: number}>} activations
 * @property {PositionedMessage[]} messages
 * @property {Array<{placement: 'left'|'right'|'over', participants: string[], x: number,
 *                   y: number, w: number, h: number, label: string[]}>} notes
 * @property {Array<{kind: string, depth: number, x: number, y: number, w: number, h: number,
 *                   label: string[],
 *                   dividers: Array<{y: number, label: string[]}>}>} blocks
 * @property {{fontSize: number, lineHeight: number}} metrics
 */

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Wrap and measure a label.
 *
 * `\n` (which the parser produced from `<br/>`) is an author line break and is honoured
 * before wrapping, so a deliberate break is never re-flowed away.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @param {{size: number, weight?: 'normal'|'bold'}} opts
 * @returns {{ lines: string[], width: number, height: number }}
 */
function layoutLines(text, maxWidth, opts) {
  const source = String(text ?? '');
  if (!source) return { lines: [], width: 0, height: 0 };
  /** @type {string[]} */
  const lines = [];
  for (const segment of source.split('\n')) {
    if (lines.length >= MAX_LABEL_LINES) break;
    const wrapped = segment ? wrapText(segment, maxWidth, opts) : [''];
    for (const line of wrapped) {
      if (lines.length >= MAX_LABEL_LINES) break;
      lines.push(line);
    }
  }
  if (lines.length >= MAX_LABEL_LINES) lines[MAX_LABEL_LINES - 1] = `${lines[MAX_LABEL_LINES - 1]}…`;
  let width = 0;
  for (const line of lines) width = Math.max(width, measureText(line, opts).width);
  const lineHeight = measureText('M', opts).height;
  return { lines, width, height: lines.length * lineHeight };
}

/**
 * Centre point of a label block, or null when there is nothing to place.
 * @param {string[]} lines
 * @param {number} cx
 * @param {number} cy
 * @returns {{x: number, y: number}|null}
 */
function labelAt(lines, cx, cy) {
  return lines.length ? { x: round2(cx), y: round2(cy) } : null;
}

/**
 * Running centre positions from the current gap vector.
 * @param {number[]} halves
 * @param {number[]} gaps
 * @returns {number[]}
 */
function centresOf(halves, gaps) {
  const centres = new Array(halves.length);
  centres[0] = 0;
  for (let i = 1; i < halves.length; i += 1) {
    centres[i] = centres[i - 1] + halves[i - 1] + gaps[i - 1] + halves[i];
  }
  return centres;
}

/**
 * Pick the adjacent-lifeline gap inside `i..j` that a label should be drawn in: the one
 * closest to the arrow's midpoint among those wide enough, falling back to the closest
 * one overall when nothing fits (the solver then widens exactly that gap).
 *
 * Ties go to the lower index, so the choice never depends on iteration order.
 *
 * @param {number[]} centres
 * @param {number} i
 * @param {number} j
 * @param {number} need
 * @returns {{ index: number, fits: boolean }}
 */
function chooseSlot(centres, i, j, need) {
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  const mid = (centres[lo] + centres[hi]) / 2;
  let fitIndex = -1;
  let fitScore = Infinity;
  let anyIndex = lo;
  let anyScore = Infinity;
  for (let k = lo; k < hi; k += 1) {
    const width = centres[k + 1] - centres[k];
    const score = Math.abs((centres[k] + centres[k + 1]) / 2 - mid);
    if (score < anyScore) { anyScore = score; anyIndex = k; }
    if (width + EPS >= need && score < fitScore) { fitScore = score; fitIndex = k; }
  }
  return fitIndex === -1 ? { index: anyIndex, fits: false } : { index: fitIndex, fits: true };
}

/**
 * Widen the gaps until every constraint holds.
 *
 * Widening is monotone -- no rule ever pulls lifelines back together -- so the loop is
 * bounded by a pass count rather than by convergence, and stops early once a pass changes
 * nothing.
 *
 * @param {number[]} halves
 * @param {number[]} gaps mutated in place
 * @param {{gap: object[], span: object[], slot: object[]}} constraints
 */
function solveGaps(halves, gaps, constraints) {
  for (let pass = 0; pass < MAX_SOLVE_PASSES; pass += 1) {
    let changed = false;

    for (const c of constraints.gap) {
      const want = c.minDist - halves[c.index] - halves[c.index + 1];
      if (gaps[c.index] + EPS < want) { gaps[c.index] = want; changed = true; }
    }

    for (const c of constraints.span) {
      const centres = centresOf(halves, gaps);
      const have = centres[c.to] - centres[c.from];
      const count = c.to - c.from;
      if (count > 0 && have + EPS < c.minDist) {
        const add = (c.minDist - have) / count;
        for (let k = c.from; k < c.to; k += 1) gaps[k] += add;
        changed = true;
      }
    }

    for (const c of constraints.slot) {
      const centres = centresOf(halves, gaps);
      const slot = chooseSlot(centres, c.from, c.to, c.need);
      if (!slot.fits) {
        gaps[slot.index] += c.need - (centres[slot.index + 1] - centres[slot.index]);
        changed = true;
      }
    }

    if (!changed) break;
  }
}

/**
 * Lay a parsed sequence diagram out.
 *
 * @param {import('./parse.js').SequenceModel} model
 * @param {{ fontSize?: number, maxMessageWidth?: number, maxNoteWidth?: number,
 *           maxParticipantWidth?: number, repeatHeaderAfter?: number }} [opts]
 * @returns {PositionedSequence}
 */
export function layoutSequence(model, opts = {}) {
  const fontSize = opts.fontSize ?? 13;
  const maxMessageWidth = opts.maxMessageWidth ?? 240;
  const maxNoteWidth = opts.maxNoteWidth ?? 200;
  const maxParticipantWidth = opts.maxParticipantWidth ?? 180;
  const repeatAfter = opts.repeatHeaderAfter ?? REPEAT_HEADER_AFTER;
  const body = { size: fontSize };
  const strong = { size: fontSize, weight: /** @type {'bold'} */ ('bold') };
  const lineHeight = measureText('M', body).height;

  const order = Array.isArray(model?.participants) ? model.participants : [];
  if (order.length === 0) {
    return {
      width: 0, height: 0, title: model?.title ?? null, order: [], participants: [],
      lifelines: [], activations: [], messages: [], notes: [], blocks: [],
      metrics: { fontSize, lineHeight: round2(lineHeight) },
    };
  }

  const indexOf = new Map(order.map((p, i) => [p.id, i]));
  const last = order.length - 1;

  // --- pass 1: measure -----------------------------------------------------------

  const columns = order.map((p) => {
    const text = layoutLines(p.label || p.id, maxParticipantWidth, strong);
    const w = Math.max(PARTICIPANT_MIN_W, Math.ceil(text.width) + PARTICIPANT_PAD_X * 2);
    const h = Math.max(PARTICIPANT_MIN_H, text.height + PARTICIPANT_PAD_Y * 2);
    // Even widths keep the lifeline on a whole pixel, which keeps hairlines crisp.
    return {
      id: p.id, actor: p.kind === 'actor', lines: text.lines, w: Math.ceil(w / 2) * 2, h,
    };
  });
  const headerH = Math.ceil(columns.reduce((max, c) => Math.max(max, c.h), 0));
  const halves = columns.map((c) => c.w / 2);

  const events = Array.isArray(model?.events) ? model.events : [];

  /** @type {{gap: object[], span: object[], slot: object[]}} */
  const constraints = { gap: [], span: [], slot: [] };
  /** Extra room needed to the left of the first lifeline / right of the last. */
  let overhangL = halves[0];
  let overhangR = halves[last];
  /** Measurements keyed by event position, so pass 2 does not measure anything again. */
  const measured = new Map();
  /** @type {Map<number, {min: number, max: number}>} */
  const blockSpan = new Map();
  /** @type {number[]} */
  const openBlocks = [];
  let maxBlockDepth = 0;
  let counter = model?.autonumber ? (model.autonumberStart ?? 1) : 0;

  /**
   * Record that a block (and every block it sits inside) covers a participant column.
   * @param {number} i
   */
  const cover = (i) => {
    for (const id of openBlocks) {
      const span = blockSpan.get(id);
      if (i < span.min) span.min = i;
      if (i > span.max) span.max = i;
    }
  };

  /**
   * Activation depth per participant, replayed here in exactly the order pass 2 pushes and
   * pops its bars. A self-message's loop hangs off the *outer edge of the bars stacked on the
   * lifeline*, not off the lifeline itself, so reserving width from the lifeline alone lets
   * the label run over the neighbouring column once the stack is a few deep.
   * @type {Map<string, number>}
   */
  const barDepth = new Map();
  /** @param {string} id @param {number} delta */
  const bumpDepth = (id, delta) => barDepth.set(id, Math.max(0, (barDepth.get(id) || 0) + delta));
  /** @param {string} id @returns {number} how far right of the lifeline a message attaches */
  const anchorOffset = (id) => {
    const depth = barDepth.get(id) || 0;
    return depth === 0 ? 0 : ACTIVATION_W / 2 + (depth - 1) * ACTIVATION_NEST;
  };

  for (let e = 0; e < events.length; e += 1) {
    const ev = events[e];
    if (ev.type === 'message') {
      const from = indexOf.get(ev.from);
      const to = indexOf.get(ev.to);
      if (from === undefined || to === undefined) continue;
      cover(from);
      cover(to);
      const number = model.autonumber ? counter : null;
      if (model.autonumber) counter += model.autonumberStep ?? 1;
      const display = number === null ? ev.text : `${number} ${ev.text}`.trim();
      const text = layoutLines(display, maxMessageWidth, body);
      measured.set(e, { text, number });
      if (ev.activateTarget) bumpDepth(ev.to, 1);
      if (from === to) {
        const need = anchorOffset(ev.from)
          + SELF_LOOP_W + SELF_LABEL_GAP + text.width + NOTE_CLEAR;
        if (from < last) constraints.gap.push({ index: from, minDist: need });
        else overhangR = Math.max(overhangR, need);
      } else {
        constraints.slot.push({ from, to, need: text.width + MESSAGE_LABEL_PAD * 2 });
      }
      if (ev.deactivateSource) bumpDepth(ev.from, -1);
      continue;
    }

    if (ev.type === 'note') {
      const cols = ev.participants.map((id) => indexOf.get(id)).filter((i) => i !== undefined);
      if (cols.length === 0) continue;
      for (const i of cols) cover(i);
      const text = layoutLines(ev.text, maxNoteWidth, body);
      const w = Math.max(PARTICIPANT_MIN_W, Math.ceil(text.width) + NOTE_PAD_X * 2);
      const h = Math.max(lineHeight + NOTE_PAD_Y * 2, text.height + NOTE_PAD_Y * 2);
      measured.set(e, { text, w, h, cols });
      const lo = Math.min(...cols);
      const hi = Math.max(...cols);
      if (ev.placement === 'left') {
        const need = w + NOTE_OFFSET + NOTE_CLEAR;
        if (lo > 0) constraints.gap.push({ index: lo - 1, minDist: need });
        else overhangL = Math.max(overhangL, need);
      } else if (ev.placement === 'right') {
        const need = w + NOTE_OFFSET + NOTE_CLEAR;
        if (hi < last) constraints.gap.push({ index: hi, minDist: need });
        else overhangR = Math.max(overhangR, need);
      } else if (lo === hi) {
        if (lo === 0) overhangL = Math.max(overhangL, w / 2);
        if (hi === last) overhangR = Math.max(overhangR, w / 2);
      } else {
        const minDist = w - halves[lo] - halves[hi];
        if (minDist > 0) constraints.span.push({ from: lo, to: hi, minDist });
      }
      continue;
    }

    if (ev.type === 'activate' || ev.type === 'deactivate') {
      const i = indexOf.get(ev.participant);
      if (i !== undefined) cover(i);
      bumpDepth(ev.participant, ev.type === 'activate' ? 1 : -1);
      continue;
    }

    if (ev.type === 'block-start') {
      openBlocks.push(ev.id);
      maxBlockDepth = Math.max(maxBlockDepth, openBlocks.length);
      blockSpan.set(ev.id, { min: Infinity, max: -Infinity });
      const tab = layoutLines(ev.keyword, maxMessageWidth, strong);
      const text = layoutLines(ev.label, maxMessageWidth, body);
      const tabW = Math.max(BLOCK_TAB_MIN_W, Math.ceil(tab.width) + BLOCK_TAB_PAD * 2);
      measured.set(e, { text, tabW });
      continue;
    }

    if (ev.type === 'block-section') {
      const label = `${ev.keyword}${ev.label ? ` ${ev.label}` : ''}`;
      measured.set(e, { text: layoutLines(label, maxMessageWidth, body) });
      continue;
    }

    if (ev.type === 'block-end') {
      const at = openBlocks.lastIndexOf(ev.id);
      if (at !== -1) openBlocks.splice(at, 1);
      continue;
    }
  }
  openBlocks.length = 0;

  // Frames need room for their tab and title; the span they enclose has to supply it.
  for (let e = 0; e < events.length; e += 1) {
    const ev = events[e];
    if (ev.type !== 'block-start') continue;
    const info = measured.get(e);
    const span = blockSpan.get(ev.id);
    const width = info.tabW + Math.ceil(info.text.width) + BLOCK_PAD * 2;
    if (!span || span.min > span.max) continue;
    if (span.min === span.max) {
      if (span.min === 0) overhangL = Math.max(overhangL, width / 2);
      if (span.max === last) overhangR = Math.max(overhangR, width / 2);
      continue;
    }
    const minDist = width - halves[span.min] - halves[span.max] - BLOCK_MARGIN_X * 2;
    if (minDist > 0) constraints.span.push({ from: span.min, to: span.max, minDist });
  }
  if (maxBlockDepth > 0) {
    const frameReach = BLOCK_MARGIN_X + maxBlockDepth * BLOCK_PAD;
    overhangL = Math.max(overhangL, halves[0] + frameReach);
    overhangR = Math.max(overhangR, halves[last] + frameReach);
  }

  const gaps = new Array(Math.max(0, order.length - 1)).fill(PARTICIPANT_GAP);
  solveGaps(halves, gaps, constraints);
  const relative = centresOf(halves, gaps);
  // `overhang` is an upper bound on what hangs off either end. Anything it over-reserved is
  // reclaimed by the final shift, which pulls the leftmost ink back onto x = 0.
  const centre = relative.map((x) => overhangL + x);

  // --- pass 2: rows --------------------------------------------------------------

  /** @type {PositionedParticipant[]} */
  const participants = columns.map((c, i) => ({
    id: c.id,
    label: c.lines,
    actor: c.actor,
    x: round2(centre[i]),
    y: 0,
    w: round2(c.w),
    h: round2(headerH),
    bottomY: /** @type {number|null} */ (null),
  }));

  /** @type {PositionedMessage[]} */
  const messages = [];
  /** @type {PositionedSequence['notes']} */
  const notes = [];
  /** @type {PositionedSequence['activations']} */
  const activations = [];
  /** @type {any[]} */
  const blocks = [];
  /** @type {Map<string, Array<{level: number, startY: number, pending: boolean}>>} */
  const stacks = new Map();
  /** @type {any[]} */
  const frames = [];

  const lifelineTop = headerH;
  let y = lifelineTop + LIFELINE_TOP;
  let lastMessageY = y;
  // A message does not advance `y` past its own arrow, so a frame opened straight after one
  // would take its top edge from exactly that row and draw its border along the arrow of a
  // message that is not even inside it. Remembered separately from `lastMessageY`, which
  // `deactivate` needs to keep pointing at the arrow itself.
  let lastArrowY = -Infinity;
  let maxX = centre[last] + halves[last];
  let minX = centre[0] - halves[0];

  /** @param {string} id */
  const depthOf = (id) => (stacks.get(id) || []).length;

  /**
   * The x a message attaches to on a participant: the lifeline, or the outer edge of the
   * activation bars currently stacked on it.
   * @param {number} i
   * @param {'left'|'right'} side
   * @returns {number}
   */
  const anchorX = (i, side) => {
    const depth = depthOf(order[i].id);
    if (depth === 0) return centre[i];
    return side === 'right'
      ? centre[i] + ACTIVATION_W / 2 + (depth - 1) * ACTIVATION_NEST
      : centre[i] - ACTIVATION_W / 2;
  };

  /**
   * @param {string} id
   * @param {number} startY
   * @param {boolean} pending true while the bar is waiting for the message that starts it
   */
  const pushBar = (id, startY, pending) => {
    const stack = stacks.get(id) || [];
    stack.push({ level: stack.length, startY, pending });
    stacks.set(id, stack);
  };

  /**
   * @param {string} id
   * @param {number} endY
   */
  const popBar = (id, endY) => {
    const stack = stacks.get(id);
    if (!stack || stack.length === 0) return;
    const bar = stack.pop();
    const i = indexOf.get(id);
    if (i === undefined) return;
    const top = bar.startY;
    const bottom = Math.max(endY, top + ACTIVATION_MIN_H);
    activations.push({
      participant: id,
      x: round2(centre[i] - ACTIVATION_W / 2 + bar.level * ACTIVATION_NEST),
      y: round2(top),
      w: ACTIVATION_W,
      h: round2(bottom - top),
      level: bar.level,
    });
    maxX = Math.max(maxX, centre[i] + ACTIVATION_W / 2 + bar.level * ACTIVATION_NEST);
  };

  /** An explicit `activate` starts its bar at the next message, not where it was written. */
  const resolvePending = (at) => {
    for (const stack of stacks.values()) {
      for (const bar of stack) {
        if (bar.pending) { bar.startY = at; bar.pending = false; }
      }
    }
  };

  for (let e = 0; e < events.length; e += 1) {
    const ev = events[e];

    if (ev.type === 'message') {
      const from = indexOf.get(ev.from);
      const to = indexOf.get(ev.to);
      const info = measured.get(e);
      if (from === undefined || to === undefined || !info) continue;
      const labelH = info.text.height;
      const self = from === to;

      if (self) {
        y += Math.max(MESSAGE_GAP, labelH / 2 + MESSAGE_LABEL_CLEAR * 2);
      } else {
        y += Math.max(MESSAGE_GAP, labelH + MESSAGE_LABEL_GAP + MESSAGE_LABEL_CLEAR);
      }
      const arrowY = y;
      resolvePending(arrowY);
      if (ev.activateTarget) pushBar(ev.to, arrowY, false);

      /** @type {Array<{x: number, y: number}>} */
      let points;
      /** @type {{x: number, y: number}|null} */
      let labelPos;
      let x1;
      let x2;

      if (self) {
        x1 = anchorX(from, 'right');
        x2 = x1;
        const bottom = arrowY + SELF_LOOP_H;
        points = [
          { x: x1, y: arrowY },
          { x: x1 + SELF_LOOP_W, y: arrowY },
          { x: x1 + SELF_LOOP_W, y: bottom },
          { x: x1, y: bottom },
        ];
        const labelX = x1 + SELF_LOOP_W + SELF_LABEL_GAP;
        labelPos = labelAt(info.text.lines, labelX, (arrowY + bottom) / 2);
        if (labelPos) maxX = Math.max(maxX, labelX + info.text.width + LABEL_PLATE_PAD);
        maxX = Math.max(maxX, x1 + SELF_LOOP_W);
        y = Math.max(bottom, (arrowY + bottom) / 2 + labelH / 2) + MESSAGE_LABEL_CLEAR;
      } else {
        const forward = from < to;
        x1 = anchorX(from, forward ? 'right' : 'left');
        x2 = anchorX(to, forward ? 'left' : 'right');
        points = [{ x: x1, y: arrowY }, { x: x2, y: arrowY }];
        // The label goes in the gap the solver reserved for it, not on the arrow's midpoint:
        // for a message spanning several columns those are different places, and only the
        // former is guaranteed clear of the lifelines in between.
        const need = info.text.width + MESSAGE_LABEL_PAD * 2;
        const slot = chooseSlot(centre, from, to, need);
        const labelX = (centre[slot.index] + centre[slot.index + 1]) / 2;
        labelPos = labelAt(info.text.lines, labelX, arrowY - MESSAGE_LABEL_GAP - labelH / 2);
      }

      if (ev.deactivateSource) popBar(ev.from, arrowY);
      lastMessageY = arrowY;
      lastArrowY = arrowY;

      messages.push({
        from: ev.from,
        to: ev.to,
        kind: ev.arrow.token,
        dashed: ev.arrow.line === 'dotted',
        self,
        x1: round2(x1),
        x2: round2(x2),
        y: round2(arrowY),
        height: self ? SELF_LOOP_H : 0,
        selfWidth: self ? SELF_LOOP_W : 0,
        points: points.map((p) => ({ x: round2(p.x), y: round2(p.y) })),
        label: info.text.lines,
        labelPos,
        number: info.number,
      });
      continue;
    }

    if (ev.type === 'note') {
      const info = measured.get(e);
      if (!info) continue;
      const lo = Math.min(...info.cols);
      const hi = Math.max(...info.cols);
      let x;
      let w = info.w;
      if (ev.placement === 'left') {
        x = centre[lo] - NOTE_OFFSET - w;
      } else if (ev.placement === 'right') {
        x = centre[hi] + NOTE_OFFSET;
      } else if (lo === hi) {
        x = centre[lo] - w / 2;
      } else {
        const left = centre[lo] - halves[lo];
        const right = centre[hi] + halves[hi];
        w = Math.max(w, right - left);
        x = (left + right) / 2 - w / 2;
      }
      y += NOTE_GAP;
      notes.push({
        placement: ev.placement,
        participants: ev.participants.slice(),
        x: round2(x),
        y: round2(y),
        w: round2(w),
        h: round2(info.h),
        label: info.text.lines,
      });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + w);
      y += info.h + NOTE_GAP;
      continue;
    }

    if (ev.type === 'activate') {
      pushBar(ev.participant, y, true);
      continue;
    }

    if (ev.type === 'deactivate') {
      popBar(ev.participant, lastMessageY);
      continue;
    }

    if (ev.type === 'block-start') {
      const info = measured.get(e);
      if (!info) continue;
      const span = blockSpan.get(ev.id) || { min: 0, max: last };
      const lo = Number.isFinite(span.min) ? span.min : 0;
      const hi = Number.isFinite(span.max) && span.max >= 0 ? span.max : last;
      // Clear the previous row before opening the frame, so the top border never lands on
      // the arrow of the message above it.
      if (Number.isFinite(lastArrowY)) y = Math.max(y, lastArrowY + BLOCK_GAP);
      frames.push({
        id: ev.id,
        keyword: ev.keyword,
        depth: openBlocks.length,
        top: y,
        left: centre[lo] - halves[lo] - BLOCK_MARGIN_X,
        right: centre[hi] + halves[hi] + BLOCK_MARGIN_X,
        tabW: info.tabW,
        lines: info.text.lines,
        textW: info.text.width,
        dividers: [],
      });
      openBlocks.push(ev.id);
      y += BLOCK_LABEL_H + BLOCK_PAD;
      continue;
    }

    if (ev.type === 'block-section') {
      const info = measured.get(e);
      const frame = frames.find((f) => f.id === ev.id && f.bottom === undefined);
      if (!frame || !info) continue;
      y += BLOCK_PAD;
      const captionH = Math.max(BLOCK_LABEL_H, info.text.height + MESSAGE_LABEL_GAP * 2);
      frame.dividers.push({ y, lines: info.text.lines });
      y += captionH;
      continue;
    }

    if (ev.type === 'block-end') {
      const at = openBlocks.lastIndexOf(ev.id);
      if (at !== -1) openBlocks.splice(at, 1);
      const frame = frames.find((f) => f.id === ev.id && f.bottom === undefined);
      if (!frame) continue;
      y += BLOCK_PAD;
      frame.bottom = y;
      // A frame must be wide enough for its own tab and title, and must contain every
      // frame nested inside it with `BLOCK_PAD` to spare -- that is what makes nesting
      // read as nesting rather than as two boxes that happen to touch.
      frame.right = Math.max(frame.right, frame.left + frame.tabW + frame.textW + BLOCK_PAD * 2);
      for (const child of frames) {
        if (child === frame || child.bottom === undefined) continue;
        if (child.top < frame.top || child.bottom > frame.bottom) continue;
        frame.left = Math.min(frame.left, child.left - BLOCK_PAD);
        frame.right = Math.max(frame.right, child.right + BLOCK_PAD);
      }
      minX = Math.min(minX, frame.left);
      maxX = Math.max(maxX, frame.right);
      y += BLOCK_GAP;
      continue;
    }
  }

  // Frames still open at the end of the stream close at the bottom of the diagram.
  for (const frame of frames) {
    if (frame.bottom === undefined) {
      frame.bottom = y;
      minX = Math.min(minX, frame.left);
      maxX = Math.max(maxX, frame.right);
    }
  }

  y += LIFELINE_BOTTOM;
  const lifelineBottom = y;
  for (const [id, stack] of stacks) {
    for (let i = stack.length - 1; i >= 0; i -= 1) popBar(id, lifelineBottom);
  }

  // A diagram taller than a screenful loses its column headings by the time the reader is
  // at the bottom, so past `REPEAT_HEADER_AFTER` the header is drawn again under the last row.
  if (lifelineBottom - lifelineTop > repeatAfter) {
    for (const participant of participants) participant.bottomY = round2(lifelineBottom);
    y += headerH;
  }

  // Bars are closed in whatever order the source deactivates them; sort so the emitted
  // list -- and therefore the SVG -- depends only on geometry.
  activations.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.level - b.level));

  const lifelines = columns.map((c, i) => ({
    id: c.id,
    x: round2(centre[i]),
    y1: round2(lifelineTop),
    y2: round2(lifelineBottom),
  }));

  // Frames are emitted outermost first so the emitter paints them back to front.
  blocks.push(...frames
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.depth - b.f.depth) || (a.f.top - b.f.top) || (a.i - b.i))
    .map(({ f }) => ({
      kind: f.keyword,
      depth: f.depth,
      x: round2(f.left),
      y: round2(f.top),
      w: round2(f.right - f.left),
      h: round2(f.bottom - f.top),
      // The tab is the width the constraint solver already reserved for the keyword; without
      // it the emitter falls back to a fixed stub that `critical` does not fit inside, and
      // the frame is left carrying room nothing is drawn in. Position and height stay the
      // emitter's business, so only the measured width crosses the boundary.
      tab: { w: round2(f.tabW) },
      label: f.lines,
      dividers: f.dividers.map((d) => ({ y: round2(d.y), label: d.lines })),
    })));

  // Positions were built around an upper-bound left overhang; slide everything so the
  // leftmost ink lands on x = 0 and the content box is exactly as wide as it needs to be.
  const shift = -minX;
  if (Math.abs(shift) > EPS) {
    const move = (o) => { if (o) o.x = round2(o.x + shift); };
    for (const p of participants) move(p);
    for (const l of lifelines) move(l);
    for (const a of activations) move(a);
    for (const n of notes) move(n);
    for (const m of messages) {
      for (const p of m.points) p.x = round2(p.x + shift);
      m.x1 = round2(m.x1 + shift);
      m.x2 = round2(m.x2 + shift);
      move(m.labelPos);
    }
    for (const b of blocks) move(b);
  }

  return {
    width: round2(maxX - minX),
    height: round2(y),
    title: model.title ?? null,
    order: order.map((p) => p.id),
    participants,
    lifelines,
    activations,
    messages,
    notes,
    blocks,
    metrics: { fontSize, lineHeight: round2(lineHeight) },
  };
}
