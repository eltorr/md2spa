/**
 * The client-side search index.
 *
 * The index is downloaded by every visitor who presses `/`, so it is optimised for size
 * rather than for readability: single-character keys, no whitespace, and a hard per-page
 * body budget. A 200-page site lands around 250 KB, which gzips to roughly 60 KB.
 *
 * Shape (`v: 1`):
 *   { v: 1, docs: [ { r: route, t: title, d: description, h: [{i: id, t: text}], b: body } ] }
 *
 * @module build/search
 */

import { normalizeRoute } from '../util/path.js';

/** Plain-text body kept per page. Enough for a useful snippet, small enough to ship. */
export const BODY_BUDGET = 1500;

/** Warn past this: the index has stopped being something you fetch on keypress. */
const SIZE_WARNING_BYTES = 1_000_000;

/** Headings kept per page; deep tables of contents add bytes without adding recall. */
const MAX_HEADINGS = 60;

/**
 * Collapse whitespace and drop control characters so the index stays compact and
 * byte-identical across platforms (CRLF sources must not change the output).
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate to `budget` characters on a word boundary, never mid-word.
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
export function truncateWords(text, budget = BODY_BUDGET) {
  const value = String(text ?? '');
  if (value.length <= budget) return value;
  const cut = value.slice(0, budget + 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the boundary if it is not absurdly early (one very long token).
  const sliced = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut.slice(0, budget);
  return sliced.replace(/\s+$/, '');
}

/**
 * @typedef {Object} SearchDocument
 * @property {string} route
 * @property {string} title
 * @property {string} [description]
 * @property {Array<{ id: string, text: string, depth: number }>} [headings]
 * @property {string} [text] plain-text body from renderHtml()
 */

/**
 * Build the search index.
 *
 * @param {SearchDocument[]} documents
 * @param {object} [config]
 * @param {{ logger?: { warn?: (msg: string) => void }, bodyBudget?: number }} [options]
 * @returns {{ v: number, docs: Array<object> }}
 */
export function buildSearchIndex(documents, config = {}, options = {}) {
  const { logger = null, bodyBudget = BODY_BUDGET } = options;
  const list = Array.isArray(documents) ? documents : [];

  /** @type {Array<object>} */
  const docs = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const doc of list) {
    if (!doc || !doc.route) continue;
    const route = normalizeRoute(doc.route);
    if (seen.has(route)) continue;
    seen.add(route);

    const title = normalizeText(doc.title || '');
    const description = normalizeText(doc.description || '');

    const headings = (Array.isArray(doc.headings) ? doc.headings : [])
      // Depth 1 is the page title, already indexed as `t`.
      .filter((h) => h && h.id && h.depth !== 1)
      .slice(0, MAX_HEADINGS)
      .map((h) => ({ i: String(h.id), t: normalizeText(h.text) }))
      .filter((h) => h.t !== '');

    const body = truncateWords(normalizeText(doc.text || ''), bodyBudget);

    // Key order is fixed so JSON.stringify output is byte-stable across runs.
    docs.push({ r: route, t: title, d: description, h: headings, b: body });
  }

  // Sort by route: deterministic output regardless of scan order.
  docs.sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0));

  const index = { v: 1, docs };

  const bytes = Buffer.byteLength(JSON.stringify(index), 'utf8');
  if (bytes > SIZE_WARNING_BYTES && logger?.warn) {
    logger.warn(
      `search index is ${(bytes / 1024 / 1024).toFixed(2)} MB (${docs.length} pages); `
      + 'consider setting `search: false` or splitting the site',
    );
  }

  return index;
}

/**
 * Serialise the index exactly as it is written to disk.
 * @param {{ v: number, docs: Array<object> }} index
 * @returns {string}
 */
export function serializeSearchIndex(index) {
  return JSON.stringify(index);
}
