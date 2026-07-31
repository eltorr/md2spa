/**
 * Filesystem helpers. The only modules allowed to touch the disk are
 * `build/*`, `content/scan.js`, `config.js`, `cli.js` and `serve.js`.
 * @module util/fs
 */

import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './path.js';

/**
 * @param {string} p
 * @returns {boolean}
 */
export function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a UTF-8 text file, stripping a leading BOM.
 * @param {string} file
 * @returns {{ text: string, hadBom: boolean, hadCrlf: boolean }}
 */
export function readTextFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;
  return { text, hadBom, hadCrlf: text.includes('\r\n') };
}

/**
 * Recursively list files under `dir`.
 *
 * @param {string} dir
 * @param {{ filter?: (relPosix: string, entry: fs.Dirent) => boolean,
 *           skipDir?: (name: string, relPosix: string) => boolean }} [opts]
 * @returns {string[]} POSIX paths relative to `dir`, sorted for deterministic output
 */
export function walkDir(dir, opts = {}) {
  const { filter = () => true, skipDir = () => false } = opts;
  /** @type {string[]} */
  const out = [];
  if (!isDirectory(dir)) return out;

  // Symlinks are resolved and confined to the walked tree. A docs repo is often built by
  // CI with a checkout of somebody else's branch, so a committed `content/leak.md ->
  // ../../.env` must not be able to publish a secret to a public site. Confining rather
  // than ignoring keeps legitimate in-tree symlinks (shared fragments) working.
  const root = fs.realpathSync(dir);
  const insideRoot = (target) => target === root || target.startsWith(root + path.sep);

  const walk = (absDir, relDir, seen) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);

      let real;
      let stat;
      try {
        real = fs.realpathSync(abs);
        stat = fs.statSync(abs);
      } catch {
        continue; // broken symlink or a race with a concurrent delete
      }
      if (!insideRoot(real)) continue;

      if (stat.isDirectory()) {
        if (skipDir(entry.name, rel)) continue;
        if (seen.has(real)) continue; // a symlink cycle back into the tree
        walk(abs, rel, new Set(seen).add(real));
      } else if (stat.isFile()) {
        if (filter(rel, entry)) out.push(rel);
      }
    }
  };

  walk(dir, '', new Set([root]));
  return out.sort();
}

/**
 * Write a file, creating parent directories as needed.
 * @param {string} file
 * @param {string|Buffer} content
 */
export function writeFileDeep(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Copy a directory tree. Returns the POSIX-relative paths that were copied.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function copyDirDeep(from, to) {
  if (!isDirectory(from)) return [];
  const files = walkDir(from);
  for (const rel of files) {
    const src = path.join(from, ...rel.split('/'));
    const dest = path.join(to, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return files;
}

/**
 * Remove everything inside `dir` (creating it if absent) without deleting `dir` itself,
 * so a dev server holding the directory open keeps working.
 *
 * Refuses to run on a suspiciously shallow path -- a misconfigured `outDir` must never
 * be able to wipe a home directory or a drive root.
 *
 * @param {string} dir
 */
export function emptyDir(dir) {
  const resolved = path.resolve(dir);
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Refusing to empty a top-level path: ${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  for (const entry of fs.readdirSync(resolved)) {
    fs.rmSync(path.join(resolved, entry), { recursive: true, force: true });
  }
}

/**
 * Path relative to `from`, in POSIX form -- used for diagnostic `file` fields.
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relPosix(from, to) {
  const rel = toPosix(path.relative(from, to));
  if (!rel) return '.';
  // A file outside `from` produces a long `../../../..` climb that is harder to read --
  // and harder to click in a terminal -- than the absolute path. Diagnostics are the main
  // consumer here, and `md2spa check /elsewhere/notes.md` is a normal thing to run.
  return rel.startsWith('..') ? toPosix(path.resolve(to)) : rel;
}
