/**
 * Deterministic content hashing for cache-busted asset filenames.
 * @module util/hash
 */

import { createHash } from 'node:crypto';

/**
 * Short, stable content hash. Deterministic across machines and runs -- builds are
 * reproducible, so a rebuild with unchanged input produces byte-identical output.
 *
 * @param {string|Buffer} content
 * @param {number} [length=8]
 * @returns {string} lowercase hex
 */
export function shortHash(content, length = 8) {
  return createHash('sha256').update(content).digest('hex').slice(0, length);
}

/**
 * Insert a hash before a filename's extension: `style.css` -> `style.abc12345.css`.
 * @param {string} filename
 * @param {string} hash
 * @returns {string}
 */
export function hashedName(filename, hash) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return `${filename}.${hash}`;
  return `${filename.slice(0, dot)}.${hash}${filename.slice(dot)}`;
}
