/**
 * Content discovery: walk `contentDir` once and turn it into the page list the rest of the
 * build works from. No configuration is consulted about *which* pages exist -- the folder
 * tree is the answer (SPEC 7b).
 *
 * Frontmatter is parsed here rather than during rendering because routing decisions
 * (`draft`, `nav`, `order`, `title`) have to be made before anything is rendered.
 * The full document is parsed again later by `markdown/parser.js`; that pass owns the
 * frontmatter diagnostics so they are not reported twice.
 *
 * @module content/scan
 */

import path from 'node:path';
import { walkDir, readTextFile, isDirectory } from '../util/fs.js';
import { toPosix } from '../util/path.js';
import { createBag } from '../markdown/diagnostics.js';
import { resolveDirs, stripJsonComments } from '../config.js';
import { parseFrontmatter } from '../markdown/frontmatter.js';
import {
  parseContentPath,
  dirPathToRoute,
  isHiddenName,
  isMarkdownFile,
} from './route.js';

/** Per-folder navigation metadata file. Optional, every key optional. */
export const META_FILENAME = '_meta.json';

/**
 * @typedef {Object} PageSource
 * @property {string} file        path relative to cwd, POSIX -- `content/guide/install.md`
 * @property {string} relPath     path relative to contentDir -- `guide/install.md`
 * @property {string} route       `/guide/install/`
 * @property {string} dir         route of the containing folder, `/guide/`
 * @property {boolean} isIndex
 * @property {number} depth       output-file depth (number of `../` back to the site root)
 * @property {number} level       route nesting level
 * @property {string[]} segments
 * @property {string[]} dirNames  raw folder names, for titles and `_meta` lookups
 * @property {string} rawName     `01-install.md`
 * @property {string} name        `install`
 * @property {number|null} order  numeric filename prefix
 * @property {string} source      raw Markdown, BOM stripped, frontmatter included
 * @property {string} body        Markdown with the frontmatter block removed
 * @property {object} frontmatter
 * @property {string|null} title  frontmatter title, if any
 * @property {boolean} hidden     `nav: false` -- built, but kept out of the sidebar
 * @property {string|null} navTitle sidebar override from `nav: "Short name"`
 * @property {boolean} draft      `draft: true` (only present when drafts are included)
 * @property {boolean} hadBom
 * @property {boolean} hadCrlf
 */

/**
 * Walk `contentDir` and collect every buildable page plus each folder's `_meta.json`.
 *
 * A missing `contentDir` yields an empty result without a diagnostic -- `loadConfig()`
 * already reports that as `CFG003`, and duplicating it just doubles the noise.
 *
 * Each `meta` value is the parsed `_meta.json` plus a `file` property naming its source,
 * so diagnostics raised later can point at it.
 *
 * Called either as `scanContent(cwd, config)` or, as SPEC 6 writes it, `scanContent(config)`
 * -- in the latter case the working directory comes from `config.cwd`, else `process.cwd()`.
 *
 * @param {string|object} cwd working directory, or the config itself
 * @param {object} [config] `includeDrafts: true` keeps `draft` pages (the dev server sets it)
 * @returns {{ pages: PageSource[], meta: Map<string, object>, assets: string[],
 *             contentDir: string, contentRel: string,
 *             diagnostics: import('../markdown/diagnostics.js').Diagnostic[] }}
 */
export function scanContent(cwd, config = {}) {
  if (cwd && typeof cwd === 'object') {
    config = cwd;
    cwd = config.cwd || process.cwd();
  }
  cwd = cwd || process.cwd();
  const dirs = resolveDirs(cwd, config);
  const contentDir = dirs.contentDir;
  const contentRel = toPosix(path.relative(cwd, contentDir)) || '.';
  const prefix = contentRel === '.' || contentRel === '' ? '' : `${contentRel}/`;
  const includeDrafts = config.includeDrafts === true;

  /** @type {PageSource[]} */
  const pages = [];
  /** @type {Map<string, object>} */
  const meta = new Map();
  /** @type {string[]} */
  const assets = [];
  /** @type {import('../markdown/diagnostics.js').Diagnostic[]} */
  const diagnostics = [];
  /** @type {Map<string, PageSource>} */
  const seenRoutes = new Map();

  if (!isDirectory(contentDir)) {
    return { pages, meta, assets, contentDir, contentRel, diagnostics };
  }

  const entries = walkDir(contentDir, {
    skipDir: (name) => isHiddenName(name),
    filter: (rel) => {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (base === META_FILENAME) return true;
      if (isHiddenName(base)) return false;
      return true;
    },
  });

  for (const rel of entries) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const file = `${prefix}${rel}`;

    if (base === META_FILENAME) {
      const relDir = rel.slice(0, Math.max(0, rel.length - base.length - 1));
      readMeta(path.join(contentDir, ...rel.split('/')), file, relDir, meta, diagnostics, config);
      continue;
    }

    if (!isMarkdownFile(base)) {
      assets.push(rel);
      continue;
    }

    const page = readPage(contentDir, rel, file, config, diagnostics);
    if (!page) continue;

    if (page.frontmatter.draft === true && !includeDrafts) continue;

    const clash = seenRoutes.get(page.route);
    if (clash) {
      const bag = createBag(file, { rules: config.rules });
      bag.add('NAV001', { line: 1, column: 1 },
        `route \`${page.route}\` is already produced by \`${clash.file}\``,
        'Rename one of the files, or move it into its own folder. Numeric prefixes and '
        + 'the `.md` extension are stripped from routes, so `01-intro.md` and `intro.md` collide.');
      diagnostics.push(...bag.list());
      continue;
    }

    seenRoutes.set(page.route, page);
    pages.push(page);
  }

  pages.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  return { pages, meta, assets, contentDir, contentRel, diagnostics };
}

/**
 * Read and describe one Markdown file.
 *
 * @param {string} contentDir absolute
 * @param {string} rel POSIX, relative to contentDir
 * @param {string} file POSIX, relative to cwd (diagnostic identity)
 * @param {object} config
 * @param {import('../markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @returns {PageSource|null}
 */
function readPage(contentDir, rel, file, config, diagnostics) {
  const abs = path.join(contentDir, ...rel.split('/'));
  let text = '';
  let hadBom = false;
  let hadCrlf = false;

  try {
    const read = readTextFile(abs);
    text = read.text;
    hadBom = read.hadBom;
    hadCrlf = read.hadCrlf;
  } catch (err) {
    const bag = createBag(file, { rules: config.rules });
    bag.add('MD001', { line: 1, column: 1 }, `could not read file: ${err.message}`);
    diagnostics.push(...bag.list());
    return null;
  }

  const { frontmatter, body } = extractFrontmatter(text, file, config, diagnostics);
  const info = parseContentPath(rel, config);
  const nav = frontmatter.nav;

  return {
    file,
    relPath: info.relPath,
    route: info.route,
    dir: info.dir,
    isIndex: info.isIndex,
    depth: info.depth,
    level: info.level,
    segments: info.segments,
    dirNames: info.dirNames,
    rawName: info.rawName,
    name: info.name,
    order: info.order,
    source: text,
    body,
    frontmatter,
    title: typeof frontmatter.title === 'string' ? frontmatter.title : null,
    hidden: nav === false,
    navTitle: typeof nav === 'string' && nav.trim() ? nav.trim() : null,
    draft: frontmatter.draft === true,
    hadBom,
    hadCrlf,
  };
}

/**
 * Call the shared frontmatter parser without a diagnostic bag: the real parse pass in
 * `build/` runs `parseMarkdown()` over the same bytes and owns MD001/MD002, so reporting
 * them here would duplicate every frontmatter complaint.
 *
 * @param {string} text
 * @param {string} file
 * @param {object} config
 * @param {import('../markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @returns {{ frontmatter: object, body: string }}
 */
function extractFrontmatter(text, file, config, diagnostics) {
  try {
    const parsed = parseFrontmatter(text, null);
    if (parsed && typeof parsed === 'object') {
      const frontmatter = parsed.frontmatter ?? parsed.data ?? {};
      const body = typeof parsed.body === 'string'
        ? parsed.body
        : typeof parsed.content === 'string' ? parsed.content : text;
      return {
        frontmatter: frontmatter && typeof frontmatter === 'object' ? frontmatter : {},
        body,
      };
    }
  } catch (err) {
    const bag = createBag(file, { rules: config.rules });
    bag.add('MD001', { line: 1, column: 1 }, `could not parse frontmatter: ${err.message}`);
    diagnostics.push(...bag.list());
  }
  return { frontmatter: {}, body: text };
}

/**
 * Load one folder's `_meta.json`. Comments are tolerated; a broken file is reported and
 * ignored rather than aborting the build.
 *
 * @param {string} abs
 * @param {string} file diagnostic identity, relative to cwd
 * @param {string} relDir POSIX directory relative to contentDir
 * @param {Map<string, object>} meta
 * @param {import('../markdown/diagnostics.js').Diagnostic[]} diagnostics
 * @param {object} config
 */
function readMeta(abs, file, relDir, meta, diagnostics, config) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(readTextFile(abs).text));
  } catch (err) {
    const bag = createBag(file, { rules: config.rules });
    bag.add('CFG001', { line: 1, column: 1 },
      `could not parse ${META_FILENAME}: ${err.message}`,
      'Expected an object like `{ "title": "Guide", "order": ["intro.md"] }`. Comments are allowed.');
    diagnostics.push(...bag.list());
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const bag = createBag(file, { rules: config.rules });
    bag.add('CFG001', { line: 1, column: 1 }, `${META_FILENAME} must contain an object`);
    diagnostics.push(...bag.list());
    return;
  }

  meta.set(dirPathToRoute(relDir), { ...parsed, file });
}
