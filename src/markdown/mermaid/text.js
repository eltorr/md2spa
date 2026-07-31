/**
 * Browser-free text metrics.
 *
 * Every layout decision in this subsystem is downstream of one question: how wide is this
 * label? A browser would answer it; there is no browser at build time, and there never will
 * be one, because pulling in a headless engine would cost more than the mermaid bundle we
 * refuse to ship. So width is summed from a static per-character advance table, normalised
 * to em units and multiplied by the font size.
 *
 * The table holds the advances of the *first* font in the theme's stack -- `-apple-system`,
 * which resolves to SF Pro Text -- captured at 13px, the size diagrams actually render at.
 * Every fallback further down the stack (Segoe UI, Roboto, Arial) is narrower, by around 7%
 * for lowercase prose. So on macOS the measurement is exact and everywhere else it runs
 * slightly wide, which is the direction to be wrong in: an over-estimate leaves a node a
 * pixel roomier than it needed, an under-estimate clips the label against its own border
 * and nothing at build time can notice. {@link TEXT_PAD} adds a further flat cushion.
 *
 * SPEC-MERMAID 4 sketches the table with digits and most lowercase "~0.55"; measurement puts
 * the real figures nearer 0.60 and 0.58 for this stack. The spec's own accuracy requirement
 * -- within 8% of a browser, biased high -- decides the conflict in favour of the
 * measurements, since 0.55 would under-estimate a digit-heavy label by 10%.
 *
 * @module markdown/mermaid/text
 */

/**
 * Advance width of every printable ASCII glyph, in em units.
 *
 * Exported so tests can pin it: a silent edit here shifts the geometry of every diagram the
 * tool has ever produced, and a pinned table turns that into a visible diff.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const ASCII_ADVANCE = Object.freeze({
  // Space and the narrow punctuation cluster.
  ' ': 0.275, '!': 0.305, '"': 0.472, "'": 0.291, ',': 0.291, '.': 0.291,
  ':': 0.291, ';': 0.291, '|': 0.253,

  // Symbols.
  '#': 0.624, '$': 0.624, '%': 0.919, '&': 0.706, '(': 0.376, ')': 0.376,
  '*': 0.466, '+': 0.624, '-': 0.466, '/': 0.299, '<': 0.624, '=': 0.624,
  '>': 0.624, '?': 0.507, '@': 0.912, '[': 0.376, '\\': 0.299, ']': 0.376,
  '^': 0.624, '_': 0.578, '`': 0.494, '{': 0.376, '}': 0.376, '~': 0.624,

  // Figures are proportional in this stack, not tabular -- `1` is a third narrower than `4`.
  '0': 0.624, '1': 0.458, '2': 0.598, '3': 0.621, '4': 0.638,
  '5': 0.612, '6': 0.631, '7': 0.564, '8': 0.633, '9': 0.631,

  // Uppercase.
  A: 0.668, B: 0.651, C: 0.710, D: 0.721, E: 0.590, F: 0.566, G: 0.741,
  H: 0.736, I: 0.262, J: 0.532, K: 0.653, L: 0.562, M: 0.868, N: 0.736,
  O: 0.766, P: 0.629, Q: 0.766, R: 0.648, S: 0.631, T: 0.628, U: 0.731,
  V: 0.668, W: 0.962, X: 0.673, Y: 0.649, Z: 0.656,

  // Lowercase.
  a: 0.546, b: 0.608, c: 0.554, d: 0.608, e: 0.565, f: 0.356, g: 0.604,
  h: 0.583, i: 0.241, j: 0.241, k: 0.537, l: 0.247, m: 0.864, n: 0.578,
  o: 0.585, p: 0.605, q: 0.604, r: 0.375, s: 0.518, t: 0.357, u: 0.578,
  v: 0.536, w: 0.769, x: 0.519, y: 0.537, z: 0.533,
});

/** Advance used for every glyph when `opts.mono` is set. */
export const MONO_ADVANCE = 0.60;

/**
 * Advance for a non-ASCII glyph we have no better information about. Accented Latin,
 * Greek and Cyrillic all measure within a few percent of this.
 */
export const DEFAULT_ADVANCE = 0.62;

/** Advance for a full-width CJK glyph. Measured 0.87-0.99, so this rounds up. */
export const CJK_ADVANCE = 1.0;

/**
 * Advance for arrows, mathematical operators and technical symbols (U+2190-U+23FF).
 * Measured ~0.90; {@link DEFAULT_ADVANCE} would under-estimate a label like `A → B` by a
 * third, and those characters turn up in diagram labels constantly.
 */
export const SYMBOL_ADVANCE = 0.92;

/**
 * Advance for emoji and pictographs. Not in the contract, but they are common in diagram
 * labels and measure ~1.23em; falling back to {@link DEFAULT_ADVANCE} would halve the true
 * width and clip the label.
 */
export const EMOJI_ADVANCE = 1.25;

/**
 * Bold text is set on a heavier cut with looser advances.
 *
 * SPEC-MERMAID 4 suggests 1.04. Measured against weight 700 across a dozen strings the real
 * ratio is 1.05-1.10, so 1.04 would under-estimate every bold label -- and the same spec
 * says under-estimating is the failure that clips. 1.07 sits at the middle of the measured
 * range and over-estimates the semibold (600) cut the theme uses for titles.
 */
export const BOLD_FACTOR = 1.07;

/** Line box height as a multiple of the font size. Matches the theme's `--lh-snug`. */
export const LINE_HEIGHT = 1.35;

/**
 * Font size assumed when the caller does not say. The stylesheet sets
 * `--dg-font-size: var(--fs-sm)`, which is 0.8125rem at the 16px root.
 */
export const DEFAULT_FONT_SIZE = 13;

/**
 * Flat cushion in px added to every measured width.
 *
 * The advance table is an approximation of a font stack whose members differ from each other
 * by a percent or two, and the browser also applies hinting and subpixel rounding we cannot
 * model. Two pixels is enough to absorb that on a short label without visibly inflating a
 * long one, and it is applied once per measurement rather than per character so the error
 * does not compound.
 */
export const TEXT_PAD = 2;

/**
 * Safety valve for {@link wrapText}. A 5000-character label wrapped to a 200px column is
 * ~180 lines of unreadable diagram; past this point the label has failed at its job, so it
 * is truncated rather than allowed to dictate the page height.
 */
export const MAX_WRAP_LINES = 120;

/** Printable ASCII compiled to a dense array so measuring is a single indexed read. */
const ASCII_TABLE = new Float64Array(95);
for (const [char, advance] of Object.entries(ASCII_ADVANCE)) {
  ASCII_TABLE[char.codePointAt(0) - 32] = advance;
}

/** A tab is measured as this many spaces. */
const TAB_WIDTH = 4;

/**
 * True for code points that occupy a full-width cell.
 * @param {number} cp
 * @returns {boolean}
 */
function isFullWidth(cp) {
  return (cp >= 0x2e80 && cp <= 0x9fff)   // radicals, kana, CJK unified ideographs
    || (cp >= 0xac00 && cp <= 0xd7af)     // Hangul syllables
    || (cp >= 0xff00 && cp <= 0xff60);    // fullwidth forms
}

/**
 * True for code points that advance the pen by nothing: combining marks, joiners,
 * variation selectors and the C0/C1 controls.
 * @param {number} cp
 * @returns {boolean}
 */
function isZeroWidth(cp) {
  return cp < 0x20
    || (cp >= 0x7f && cp <= 0x9f)
    || (cp >= 0x0300 && cp <= 0x036f)
    || (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0xfe00 && cp <= 0xfe0f)
    || cp === 0xfeff;
}

/**
 * True for the pictographic blocks that render at emoji width.
 * @param {number} cp
 * @returns {boolean}
 */
function isPictograph(cp) {
  return (cp >= 0x2600 && cp <= 0x27bf)
    || (cp >= 0x2b00 && cp <= 0x2bff)
    || (cp >= 0x1f000 && cp <= 0x1faff);
}

/**
 * True for arrows, math operators and technical symbols.
 * @param {number} cp
 * @returns {boolean}
 */
function isWideSymbol(cp) {
  return cp >= 0x2190 && cp <= 0x23ff;
}

/**
 * Advance of one code point in em units, before the bold factor.
 * @param {number} cp
 * @param {boolean} mono
 * @returns {number}
 */
function advanceOf(cp, mono) {
  if (isZeroWidth(cp)) return 0;
  if (cp === 0x09) return mono ? MONO_ADVANCE * TAB_WIDTH : ASCII_TABLE[0] * TAB_WIDTH;
  // Monospace still gives CJK a double-width cell; everything else is one.
  if (isFullWidth(cp)) return mono ? MONO_ADVANCE * 2 : CJK_ADVANCE;
  if (mono) return MONO_ADVANCE;
  if (cp >= 32 && cp <= 126) return ASCII_TABLE[cp - 32];
  if (isWideSymbol(cp)) return SYMBOL_ADVANCE;
  if (isPictograph(cp)) return EMOJI_ADVANCE;
  return DEFAULT_ADVANCE;
}

/**
 * Normalise caller options once, so the hot loops read plain locals.
 * @param {{ size?: number, weight?: 'normal'|'bold', mono?: boolean }} [opts]
 * @returns {{ size: number, mono: boolean, factor: number }}
 */
function normalizeOptions(opts) {
  const size = Number.isFinite(opts?.size) && opts.size > 0 ? Number(opts.size) : DEFAULT_FONT_SIZE;
  const mono = opts?.mono === true;
  // Applied to monospace too. A bold mono cut has identical advances, so this is a pure
  // over-estimate -- which is the safe direction, and keeps one rule instead of two.
  const factor = opts?.weight === 'bold' ? BOLD_FACTOR : 1;
  return { size, mono, factor };
}

/**
 * Total advance of a single line, in em units. No padding, no font size applied.
 *
 * Exposed because layout code frequently needs to compare candidate strings against each
 * other rather than against a pixel budget, and em units make that comparison independent
 * of the font size in play.
 *
 * @param {string} text single line; embedded newlines are counted as zero-width
 * @param {{ weight?: 'normal'|'bold', mono?: boolean }} [opts]
 * @returns {number} advance in em units
 */
export function advanceEm(text, opts) {
  const { mono, factor } = normalizeOptions(opts);
  let total = 0;
  for (const char of String(text)) total += advanceOf(char.codePointAt(0), mono);
  return total * factor;
}

/**
 * Measure a string. Embedded newlines are honoured: the width is the widest line and the
 * height covers every line.
 *
 * @param {string} text
 * @param {{ size?: number, weight?: 'normal'|'bold', mono?: boolean }} [opts]
 * @returns {{ width: number, height: number, lineCount: number }} px
 */
export function measureText(text, opts) {
  const { size, mono, factor } = normalizeOptions(opts);
  const source = String(text ?? '');
  let widest = 0;
  let current = 0;
  let lineCount = 1;

  for (const char of source) {
    if (char === '\n') {
      if (current > widest) widest = current;
      current = 0;
      lineCount += 1;
      continue;
    }
    if (char === '\r') continue;
    current += advanceOf(char.codePointAt(0), mono);
  }
  if (current > widest) widest = current;

  return {
    width: widest * factor * size + TEXT_PAD,
    height: lineCount * size * LINE_HEIGHT,
    lineCount,
  };
}

/**
 * Height of a block of `count` lines. The one place line spacing is defined, so renderers
 * and layout cannot drift apart on it.
 * @param {number} count
 * @param {{ size?: number }} [opts]
 * @returns {number} px
 */
export function measureLines(count, opts) {
  const { size } = normalizeOptions(opts);
  return Math.max(0, Math.floor(count)) * size * LINE_HEIGHT;
}

/**
 * Break a single over-long word into chunks that each fit `budget` em units.
 * @param {string} word
 * @param {number} budget em units available per line
 * @param {boolean} mono
 * @returns {string[]}
 */
function breakWord(word, budget, mono) {
  const chars = Array.from(word);
  /** @type {string[]} */
  const chunks = [];
  let start = 0;

  // Bounded by construction: `start` is asserted to advance on every iteration below.
  while (start < chars.length) {
    let width = 0;
    let end = start;
    while (end < chars.length) {
      const next = advanceOf(chars[end].codePointAt(0), mono);
      if (end > start && width + next > budget) break;
      width += next;
      end += 1;
    }
    // A budget too small for even one glyph would otherwise spin forever.
    if (end === start) end = start + 1;
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }

  return chunks;
}

/**
 * Greedy wrap to a maximum width.
 *
 * Explicit newlines are hard breaks and always survive, including empty ones -- a label
 * written `a<br/><br/>b` asked for that gap. Words longer than the column are split rather
 * than allowed to overflow the node they are supposed to sit inside.
 *
 * @param {string} text
 * @param {number} maxWidth px; non-finite or non-positive means "only break on newlines"
 * @param {{ size?: number, weight?: 'normal'|'bold', mono?: boolean, maxLines?: number }} [opts]
 * @returns {string[]} the wrapped lines, never empty
 */
export function wrapText(text, maxWidth, opts) {
  const { size, mono, factor } = normalizeOptions(opts);
  const limit = Number.isFinite(opts?.maxLines) && opts.maxLines > 0
    ? Math.floor(opts.maxLines)
    : MAX_WRAP_LINES;

  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const hard = source.split('\n');

  // Work in em units so the per-character table is used directly; convert the pixel budget
  // once instead of scaling every measurement.
  const usable = Number.isFinite(maxWidth) && maxWidth > TEXT_PAD
    ? (maxWidth - TEXT_PAD) / (size * factor)
    : Infinity;

  /** @type {string[]} */
  const lines = [];
  let truncated = false;

  for (const paragraph of hard) {
    if (truncated) break;

    const words = paragraph.split(/[ \t]+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      if (lines.length >= limit) truncated = true;
      continue;
    }

    let current = '';
    let currentWidth = 0;

    const flush = () => {
      lines.push(current);
      current = '';
      currentWidth = 0;
      if (lines.length >= limit) truncated = true;
    };

    for (const word of words) {
      if (truncated) break;
      const wordWidth = advanceEm(word, { mono });
      const spaceWidth = current ? advanceOf(32, mono) : 0;

      if (current && currentWidth + spaceWidth + wordWidth > usable) flush();
      if (truncated) break;

      if (wordWidth > usable) {
        for (const chunk of breakWord(word, usable, mono)) {
          if (truncated) break;
          const chunkWidth = advanceEm(chunk, { mono });
          const gap = current ? advanceOf(32, mono) : 0;
          if (current && currentWidth + gap + chunkWidth > usable) flush();
          if (truncated) break;
          current = current ? `${current} ${chunk}` : chunk;
          currentWidth += gap + chunkWidth;
        }
        continue;
      }

      current = current ? `${current} ${word}` : word;
      currentWidth += spaceWidth + wordWidth;
    }

    if (current && !truncated) flush();
  }

  if (lines.length === 0) lines.push('');
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last ? `${last}…` : '…';
  }
  return lines;
}
