/**
 * Configuration loading, defaulting and validation.
 *
 * Every key is optional -- `md2spa build` in a folder containing `content/` works with
 * no config file at all. Unknown keys warn (CFG002) rather than throw, so a config written
 * for a newer version still builds.
 *
 * @module config
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathExists, readTextFile, isDirectory } from './util/fs.js';
import { createBag, SEVERITIES, RULES } from './markdown/diagnostics.js';

/** Filenames probed, in order, when `--config` is not given. */
export const CONFIG_FILENAMES = [
  'md2spa.config.json',
  'md2spa.config.js',
  'md2spa.config.mjs',
  '.md2sparc.json',
];

/** @type {Readonly<object>} */
export const DEFAULT_CONFIG = Object.freeze({
  title: 'Documentation',
  description: '',
  lang: 'en',

  /** '"auto"' emits document-relative URLs so the site runs at any path, on any host. */
  base: 'auto',
  siteUrl: '',

  contentDir: 'content',
  outDir: 'dist',
  staticDir: 'static',

  cleanUrls: true,
  spa: true,
  search: true,
  highlight: true,
  strict: false,
  buildDate: null,

  toc: { minDepth: 2, maxDepth: 3 },
  nav: { collapseDepth: 1, sort: 'auto', filter: true },

  theme: {
    accent: '#5b5bd6',
    accentDark: '#a5a5ff',
    defaultMode: 'auto',
    font: '',
    monoFont: '',
    logo: '',
    favicon: '',
  },

  repo: { url: '', label: '', editBase: '' },
  footer: { text: '', links: [] },

  /** Per-rule severity overrides, e.g. `{ "MD047": "off" }`. */
  rules: {},
});

/**
 * Schema used for type checking. `type` is one of
 * `string | number | boolean | object | array | string?` (`?` means nullable).
 */
const SCHEMA = {
  title: 'string',
  description: 'string',
  lang: 'string',
  base: 'string',
  siteUrl: 'string',
  contentDir: 'string',
  outDir: 'string',
  staticDir: 'string',
  cleanUrls: 'boolean',
  spa: 'boolean',
  search: 'boolean',
  highlight: 'boolean',
  strict: 'boolean',
  buildDate: 'string?',
  toc: {
    minDepth: 'number',
    maxDepth: 'number',
  },
  nav: {
    collapseDepth: 'number',
    sort: 'string',
    filter: 'boolean',
  },
  theme: {
    accent: 'string',
    accentDark: 'string',
    defaultMode: 'string',
    font: 'string',
    monoFont: 'string',
    logo: 'string',
    favicon: 'string',
  },
  repo: {
    url: 'string',
    label: 'string',
    editBase: 'string',
  },
  footer: {
    text: 'string',
    links: 'array',
  },
  rules: 'object',
};

/**
 * @param {unknown} value
 * @param {string} type
 * @returns {boolean}
 */
function matchesType(value, type) {
  const nullable = type.endsWith('?');
  const base = nullable ? type.slice(0, -1) : type;
  if (value === null || value === undefined) return nullable;
  switch (base) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/**
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate raw config against SCHEMA, reporting CFG001/CFG002.
 * @param {object} raw
 * @param {ReturnType<typeof createBag>} bag
 * @param {object} [schema]
 * @param {string} [prefix]
 */
function validateShape(raw, bag, schema = SCHEMA, prefix = '') {
  for (const [key, value] of Object.entries(raw || {})) {
    const expected = schema[key];
    const label = prefix ? `${prefix}.${key}` : key;

    if (expected === undefined) {
      bag.add('CFG002', { line: 1, column: 1 },
        `unknown config key \`${label}\``,
        'Check the spelling, or remove the key. See README.md for the full list.');
      continue;
    }

    if (typeof expected === 'object') {
      if (!matchesType(value, 'object')) {
        bag.add('CFG001', { line: 1, column: 1 },
          `\`${label}\` must be an object, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
        continue;
      }
      validateShape(value, bag, expected, label);
      continue;
    }

    if (!matchesType(value, expected)) {
      bag.add('CFG001', { line: 1, column: 1 },
        `\`${label}\` must be ${expected.replace('?', ' or null')}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
    }
  }
}

/**
 * Apply cross-field rules and normalise values into their canonical form.
 * @param {object} config
 * @param {ReturnType<typeof createBag>} bag
 * @returns {object}
 */
export function normalizeConfig(config, bag) {
  const out = deepMerge(DEFAULT_CONFIG, config);

  // A section written as `null` (or a scalar, or an array) is a CFG001 that `validateShape`
  // already reported; fall back to the defaults so normalisation below cannot dereference it
  // and turn an author's typo into an "internal error" exit.
  for (const key of ['toc', 'nav', 'theme', 'repo', 'footer', 'rules']) {
    if (!out[key] || typeof out[key] !== 'object' || Array.isArray(out[key])) {
      out[key] = deepMerge({}, DEFAULT_CONFIG[key]);
    }
  }

  // base: 'auto' | '/' | '/prefix/'
  if (out.base !== 'auto') {
    let base = String(out.base || '/');
    if (!base.startsWith('/')) base = `/${base}`;
    if (!base.endsWith('/')) base = `${base}/`;
    out.base = base.replace(/\/{2,}/g, '/');
  }

  if (out.siteUrl) out.siteUrl = String(out.siteUrl).replace(/\/+$/, '');

  if (!['auto', 'light', 'dark'].includes(out.theme.defaultMode)) {
    bag?.add('CFG001', { line: 1, column: 1 },
      `\`theme.defaultMode\` must be "auto", "light" or "dark", got "${out.theme.defaultMode}"`);
    out.theme.defaultMode = 'auto';
  }

  if (!['auto', 'alpha', 'manual'].includes(out.nav.sort)) {
    bag?.add('CFG001', { line: 1, column: 1 },
      `\`nav.sort\` must be "auto", "alpha" or "manual", got "${out.nav.sort}"`);
    out.nav.sort = 'auto';
  }

  out.toc.minDepth = Math.min(6, Math.max(1, Math.round(out.toc.minDepth)));
  out.toc.maxDepth = Math.min(6, Math.max(out.toc.minDepth, Math.round(out.toc.maxDepth)));
  out.nav.collapseDepth = Math.max(0, Math.round(out.nav.collapseDepth));

  for (const [code, severity] of Object.entries(out.rules)) {
    if (!RULES[code]) {
      bag?.add('CFG002', { line: 1, column: 1 },
        `\`rules.${code}\` is not a known rule code`,
        'Run `md2spa check --list-rules` to see every code.');
    } else if (!SEVERITIES.has(severity)) {
      bag?.add('CFG001', { line: 1, column: 1 },
        `\`rules.${code}\` must be "off", "info", "warning" or "error", got "${severity}"`);
    }
  }

  if (!Array.isArray(out.footer.links)) out.footer.links = [];
  out.footer.links = out.footer.links.filter(
    (l) => l && typeof l.label === 'string' && typeof l.url === 'string',
  );

  return out;
}

/**
 * Load configuration from disk.
 *
 * SPEC 2 documents the call as `loadConfig(cwd, overrides)`; the CLI needs `configPath`
 * as well, so both shapes are accepted -- any key other than `configPath`/`overrides` is
 * taken as a config override rather than silently discarded.
 *
 * @param {string} cwd
 * @param {{ configPath?: string|null, overrides?: object }|object} [options]
 * @returns {Promise<{ config: object, configFile: string|null, diagnostics: import('./markdown/diagnostics.js').Diagnostic[] }>}
 */
export async function loadConfig(cwd, options = {}) {
  const { configPath = null, overrides: nested = {}, ...inline } = options || {};
  const overrides = deepMerge(inline, nested || {});
  let file = null;

  if (configPath) {
    file = path.isAbsolute(configPath) ? configPath : path.join(cwd, configPath);
    if (!pathExists(file)) {
      const bag = createBag(path.relative(cwd, file) || configPath);
      bag.add('CFG001', { line: 1, column: 1 }, `config file not found: ${configPath}`);
      return { config: normalizeConfig({}, bag), configFile: null, diagnostics: bag.list() };
    }
  } else {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(cwd, name);
      if (pathExists(candidate)) { file = candidate; break; }
    }
  }

  const relFile = file ? path.relative(cwd, file).split(path.sep).join('/') : 'md2spa.config.json';
  const bag = createBag(relFile);
  let raw = {};

  if (file) {
    try {
      if (/\.(mjs|js)$/.test(file)) {
        const mod = await import(pathToFileURL(file).href);
        raw = mod.default ?? mod.config ?? {};
      } else {
        raw = JSON.parse(stripJsonComments(readTextFile(file).text));
      }
    } catch (err) {
      bag.add('CFG001', { line: 1, column: 1 },
        `could not parse config: ${err.message}`,
        'The file must be valid JSON (comments allowed) or an ES module with a default export.');
      raw = {};
    }
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    validateShape(raw, bag);
  } else {
    bag.add('CFG001', { line: 1, column: 1 }, 'config must export an object');
    raw = {};
  }

  const config = normalizeConfig(deepMerge(raw, overrides), bag);

  const contentAbs = path.isAbsolute(config.contentDir)
    ? config.contentDir
    : path.join(cwd, config.contentDir);
  if (!isDirectory(contentAbs)) {
    bag.add('CFG003', { line: 1, column: 1 },
      `content directory \`${config.contentDir}\` does not exist`,
      'Create it, set `contentDir` in your config, or run `md2spa init` to scaffold a site.');
  }

  return { config, configFile: file, diagnostics: bag.list() };
}

/**
 * Strip `//` and block comments from JSON while preserving string contents.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += ch;
  }
  return out;
}

/**
 * Absolute paths derived from a config.
 * @param {string} cwd
 * @param {object} config
 * @returns {{ contentDir: string, outDir: string, staticDir: string }}
 */
export function resolveDirs(cwd, config) {
  const base = cwd || process.cwd();
  // Fall back to the documented defaults: a caller holding a partial config (a test, a
  // programmatic embedder) should not get a `path.isAbsolute(undefined)` crash.
  const abs = (p, fallback) => {
    const value = typeof p === 'string' && p !== '' ? p : fallback;
    return path.isAbsolute(value) ? value : path.join(base, value);
  };
  return {
    contentDir: abs(config?.contentDir, DEFAULT_CONFIG.contentDir),
    outDir: abs(config?.outDir, DEFAULT_CONFIG.outDir),
    staticDir: abs(config?.staticDir, DEFAULT_CONFIG.staticDir),
  };
}
