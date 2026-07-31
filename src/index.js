/**
 * Public API.
 *
 * `md2spa` is primarily a CLI, but the same pipeline is importable so a project can wire
 * it into an existing build script:
 *
 * ```js
 * import { buildSite, loadConfig } from 'md2spa';
 * const { config } = await loadConfig(process.cwd());
 * const { diagnostics, stats } = await buildSite({ cwd: process.cwd(), config });
 * ```
 *
 * @module index
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export { buildSite } from './build/build.js';
export { parseMarkdown } from './markdown/parser.js';
export { renderHtml } from './markdown/renderer.js';
export { loadConfig, normalizeConfig, DEFAULT_CONFIG } from './config.js';

export { verifyHtml } from './build/verify.js';
export { buildSearchIndex } from './build/search.js';
export { buildSitemap, buildRobots } from './build/sitemap.js';
export { renderPageShell, renderSpaPayload, createUrlResolver } from './build/layout.js';
export { render404 } from './build/notfound.js';
export { RULES, summarize, shouldFail } from './markdown/diagnostics.js';
export { formatDiagnostics } from './report.js';

/**
 * Read the package version once, at import. Kept in sync with package.json rather than
 * duplicated, so a release cannot ship a stale number.
 * @returns {string}
 */
function readVersion() {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** @type {string} */
export const VERSION = readVersion();
