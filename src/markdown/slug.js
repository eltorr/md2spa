/**
 * Heading slug generation.
 *
 * Deliberately matches GitHub / Python-Markdown so anchors authored against those
 * renderers keep resolving. The key subtlety: characters that are neither alphanumeric
 * nor whitespace are *deleted*, not replaced with a separator.
 *
 *   "M1 Pro/Max/Ultra devices" -> "m1-promaxultra-devices"   (not "m1-pro-max-ultra-devices")
 *
 * @module markdown/slug
 */

/**
 * Convert heading text to an anchor id.
 * @param {string} text plain text, with inline markup already stripped
 * @returns {string}
 */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')  // drop punctuation without leaving a gap
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Tracks slugs already used in a document and de-duplicates them GitHub-style
 * (`intro`, `intro-1`, `intro-2`).
 *
 * @returns {{ next(text: string): { id: string, duplicate: boolean }, has(id: string): boolean, ids(): string[], reset(): void }}
 */
export function createSlugRegistry() {
  /** @type {Map<string, number>} */
  const counts = new Map();

  return {
    next(text) {
      const base = slugify(text) || 'section';
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      if (seen === 0) return { id: base, duplicate: false };

      // Skip suffixes that an explicit heading already claimed.
      let n = seen;
      let candidate = `${base}-${n}`;
      while (counts.has(candidate)) {
        n += 1;
        candidate = `${base}-${n}`;
      }
      counts.set(candidate, 1);
      return { id: candidate, duplicate: true };
    },
    has(id) {
      return counts.has(id);
    },
    ids() {
      return [...counts.keys()];
    },
    reset() {
      counts.clear();
    },
  };
}
