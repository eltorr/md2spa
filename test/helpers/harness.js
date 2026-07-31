/**
 * Shared test harness.
 *
 * Two jobs:
 *
 *  1. **Lazy module loading.** The suite is written against SPEC.md, not against whatever
 *     happens to exist on disk. A missing or broken module must fail the individual test
 *     that needs it, not abort the whole file at import time -- so every `src/` module
 *     outside the already-frozen foundation is reached through `loadSrc()`.
 *  2. **Temp-site plumbing.** Several suites need a real build, so they need a throwaway
 *     site on disk. `buildTempSite()` creates one, runs `buildSite()` against it and hands
 *     back readers for the emitted files. `cleanupTemps()` removes every directory the
 *     harness created.
 *
 * NOTE: node's test runner treats *every* `.js` file under `test/` as a test file, so this
 * module is executed as a (zero-test) suite. It therefore must import cleanly on its own:
 * only the frozen foundation modules may be imported statically here.
 *
 * @module test/helpers/harness
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../../src/config.js';
import { createBag } from '../../src/markdown/diagnostics.js';
import { createSlugRegistry } from '../../src/markdown/slug.js';

/** Absolute path of the repository root. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Absolute path of `src/`. */
export const SRC_DIR = path.join(REPO_ROOT, 'src');

/**
 * Import a module under `src/`, turning a load failure into a readable assertion message.
 *
 * @param {string} rel path relative to `src/`, e.g. `'markdown/parser.js'`
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadSrc(rel) {
  const url = new URL(rel, new URL('../../src/', import.meta.url));
  try {
    return await import(url.href);
  } catch (err) {
    throw new Error(`src/${rel} could not be loaded: ${err && err.message}`);
  }
}

/**
 * Find a named export across several candidate modules.
 *
 * SPEC.md names some helpers (`humanizeName`) without pinning the module they live in;
 * rather than guess, the test asks for the symbol and lets the implementation choose a home.
 *
 * @param {string} name exported symbol
 * @param {...string} rels candidate paths relative to `src/`
 * @returns {Promise<Function>}
 */
export async function findExport(name, ...rels) {
  const tried = [];
  for (const rel of rels) {
    try {
      const mod = await import(new URL(rel, new URL('../../src/', import.meta.url)).href);
      if (typeof mod[name] === 'function') return mod[name];
      tried.push(`src/${rel} (loaded, no \`${name}\` export)`);
    } catch (err) {
      tried.push(`src/${rel} (${err && err.message})`);
    }
  }
  throw new Error(`no module exports \`${name}\`; tried:\n  - ${tried.join('\n  - ')}`);
}

/**
 * A fully normalised config, so tests never depend on defaulting happening downstream.
 * @param {object} [overrides]
 * @returns {object}
 */
export function testConfig(overrides = {}) {
  return normalizeConfig(overrides, createBag('md2spa.config.json'));
}

/** A logger with the shape `report.js#createLogger` returns, but silent. */
export function silentLogger() {
  const noop = () => {};
  return {
    info: noop, step: noop, success: noop, warn: noop, error: noop, dim: noop,
    paint: (_name, text) => String(text),
  };
}

/**
 * Parse Markdown.
 * @param {string} source
 * @param {{ file?: string, config?: object }} [opts]
 * @returns {Promise<{ ast: object, frontmatter: object, diagnostics: object[] }>}
 */
export async function parse(source, opts = {}) {
  const { parseMarkdown } = await loadSrc('markdown/parser.js');
  return parseMarkdown(source, {
    file: opts.file || 'test.md',
    config: opts.config || testConfig(),
  });
}

/**
 * Parse + render in one step -- the shape almost every markdown assertion wants.
 *
 * @param {string} source
 * @param {{ file?: string, config?: object }} [opts]
 * @returns {Promise<{ ast: object, frontmatter: object, html: string, toc: object[],
 *   headings: object[], text: string, links: object[], images: object[],
 *   diagnostics: object[], codes: string[] }>}
 */
export async function render(source, opts = {}) {
  const config = opts.config || testConfig();
  const file = opts.file || 'test.md';
  const { renderHtml } = await loadSrc('markdown/renderer.js');
  const parsed = await parse(source, { file, config });
  const out = renderHtml(parsed.ast, {
    file,
    config,
    slugRegistry: createSlugRegistry(),
  });
  const diagnostics = dedupeDiagnostics([
    ...(parsed.diagnostics || []),
    ...(out.diagnostics || []),
  ]);
  return {
    ...out,
    ast: parsed.ast,
    frontmatter: parsed.frontmatter,
    diagnostics,
    codes: diagnostics.map((d) => d.code),
  };
}

/**
 * Every diagnostic a single document can produce: parse, structural validation and render.
 *
 * A rule may legitimately be raised by any one of the three stages -- SPEC.md pins the code
 * and the location, not the stage -- so the acceptance test looks at the union.
 *
 * @param {string} source
 * @param {{ file?: string, config?: object }} [opts]
 * @returns {Promise<object[]>}
 */
export async function diagnose(source, opts = {}) {
  const config = opts.config || testConfig();
  const file = opts.file || 'test.md';
  const { validateDocument } = await loadSrc('markdown/validate.js');
  const { renderHtml } = await loadSrc('markdown/renderer.js');

  const parsed = await parse(source, { file, config });
  const all = [...(parsed.diagnostics || [])];
  all.push(...(validateDocument(parsed.ast, {
    file,
    frontmatter: parsed.frontmatter,
    config,
  }) || []));
  const rendered = renderHtml(parsed.ast, { file, config, slugRegistry: createSlugRegistry() });
  all.push(...(rendered.diagnostics || []));
  return dedupeDiagnostics(all);
}

/**
 * Collapse identical findings reported by more than one stage.
 * @param {object[]} diagnostics
 * @returns {object[]}
 */
export function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const out = [];
  for (const d of diagnostics) {
    const key = `${d.code}|${d.line}|${d.column}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * @param {object[]} diagnostics
 * @param {string} code
 * @returns {object[]}
 */
export function withCode(diagnostics, code) {
  return diagnostics.filter((d) => d.code === code);
}

/** Directories created by {@link tempDir}, removed by {@link cleanupTemps}. */
const TEMPS = [];

/**
 * Create a throwaway directory under the OS temp dir.
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempDir(prefix = 'md2spa-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

/** Remove every directory created by {@link tempDir}. */
export function cleanupTemps() {
  while (TEMPS.length) {
    const dir = TEMPS.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leaked temp dir must never fail a test run.
    }
  }
}

/**
 * Materialise a `{ 'content/index.md': '# Hi' }` map under `root`.
 * @param {string} root
 * @param {Record<string, string|Buffer>} files POSIX-relative paths
 */
export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/**
 * Every file under `root`, as sorted POSIX-relative paths.
 * @param {string} root
 * @returns {string[]}
 */
export function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * Build a temporary site.
 *
 * @param {Record<string, string|Buffer>} files tree relative to the site root, e.g.
 *   `{ 'content/index.md': '# Home' }`
 * @param {object} [configOverrides] merged over the defaults before normalisation
 * @returns {Promise<{ cwd: string, outDir: string, config: object, result: object,
 *   read(rel: string): string, exists(rel: string): boolean, files(): string[] }>}
 */
export async function buildTempSite(files, configOverrides = {}) {
  const cwd = tempDir('md2spa-site-');
  writeTree(cwd, files);
  fs.mkdirSync(path.join(cwd, 'static'), { recursive: true });

  const config = testConfig({
    title: 'Test Site',
    contentDir: 'content',
    outDir: 'dist',
    staticDir: 'static',
    ...configOverrides,
  });

  const { buildSite } = await loadSrc('build/build.js');
  const result = await buildSite({ cwd, config, logger: silentLogger() });
  const outDir = path.isAbsolute(config.outDir) ? config.outDir : path.join(cwd, config.outDir);

  return {
    cwd,
    outDir,
    config,
    result,
    read: (rel) => fs.readFileSync(path.join(outDir, ...rel.split('/')), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(outDir, ...rel.split('/'))),
    files: () => listFiles(outDir),
  };
}

/**
 * Milliseconds spent inside `fn`, using a monotonic clock.
 * @template T
 * @param {() => T} fn
 * @returns {{ ms: number, value: T }}
 */
export function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
}
