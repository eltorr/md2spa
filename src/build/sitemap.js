/**
 * `sitemap.xml` and `robots.txt`.
 *
 * Both are skipped entirely unless `config.siteUrl` is set: without an absolute origin
 * there is no honest `<loc>` to write, and a sitemap full of relative paths is worse than
 * no sitemap at all.
 *
 * @module build/sitemap
 */

import { normalizeRoute, routeSegments } from '../util/path.js';
import { routeToSitePath } from '../content/route.js';

/**
 * XML text escaping. `<loc>` values are URLs, so `&` is the one that actually bites.
 * @param {string} text
 * @returns {string}
 */
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Shallower pages matter more; the curve is a pure function of depth so the output
 * is identical on every run.
 * @param {number} depth
 * @returns {string}
 */
function priorityFor(depth) {
  return Math.max(0.3, 1 - depth * 0.2).toFixed(1);
}

/**
 * Build `sitemap.xml`.
 *
 * @param {Array<string|{ route: string, lastmod?: string|null }>} routes
 * @param {object} config normalised config; `siteUrl` decides whether anything is emitted
 * @returns {string|null} XML, or `null` when there is no `siteUrl`
 */
export function buildSitemap(routes, config = {}) {
  const siteUrl = String(config.siteUrl || '').replace(/\/+$/, '');
  if (!siteUrl) return null;

  const cleanUrls = config.cleanUrls !== false;
  const indexRoutes = config.indexRoutes instanceof Set ? config.indexRoutes : null;
  const defaultLastmod = typeof config.buildDate === 'string' && config.buildDate
    ? config.buildDate
    : null;

  /** @type {Map<string, string|null>} */
  const entries = new Map();
  for (const item of Array.isArray(routes) ? routes : []) {
    const route = typeof item === 'string' ? item : item?.route;
    if (!route) continue;
    const normalized = normalizeRoute(route);
    if (entries.has(normalized)) continue;
    const lastmod = typeof item === 'object' && item?.lastmod ? String(item.lastmod) : defaultLastmod;
    entries.set(normalized, lastmod);
  }

  const sorted = [...entries.keys()].sort();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const route of sorted) {
    const loc = `${siteUrl}${routeToSitePath(route, {
      cleanUrls,
      isIndex: indexRoutes ? indexRoutes.has(route) : false,
    })}`;
    const lastmod = entries.get(route);
    lines.push('  <url>');
    lines.push(`    <loc>${xmlEscape(loc)}</loc>`);
    if (lastmod) lines.push(`    <lastmod>${xmlEscape(lastmod)}</lastmod>`);
    lines.push(`    <priority>${priorityFor(routeSegments(route).length)}</priority>`);
    lines.push('  </url>');
  }

  lines.push('</urlset>');
  return `${lines.join('\n')}\n`;
}

/**
 * Build `robots.txt`. Always emitted; the `Sitemap:` line only appears with a `siteUrl`.
 *
 * @param {object} config
 * @returns {string}
 */
export function buildRobots(config = {}) {
  const siteUrl = String(config.siteUrl || '').replace(/\/+$/, '');
  const lines = ['User-agent: *', 'Allow: /'];
  if (siteUrl) lines.push('', `Sitemap: ${siteUrl}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}
