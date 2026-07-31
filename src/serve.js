/**
 * Development server: static file serving, rebuild-on-change, live reload over SSE.
 *
 * Deliberately boring: `node:http` and `fs.watch`, nothing else. The server serves the
 * *built* `outDir` rather than rendering on the fly, so what you see in dev is byte-for-byte
 * what CI will publish -- the only difference is the live-reload snippet, which is injected
 * into the response stream and never written to disk.
 *
 * @module serve
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { resolveDirs } from './config.js';
import { formatDiagnostics, createLogger, supportsColor } from './report.js';
import { summarize } from './markdown/diagnostics.js';
import { isDirectory } from './util/fs.js';

/** SSE endpoint. Absolute so the snippet works at any document depth. */
export const EVENTS_PATH = '/__md2spa/events';

/** Filesystem events arrive in bursts (editors write, rename, chmod); coalesce them. */
const DEBOUNCE_MS = 80;

/** How many consecutive ports to try before giving up. */
const PORT_ATTEMPTS = 10;

/** Upper bound on non-recursive fallback watchers, so a huge tree cannot exhaust fds. */
const MAX_WATCH_DIRS = 2048;

/** Diagnostics carry a `file`; we read it back for the caret excerpt. Skip anything huge. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Keep-alive comment interval -- proxies and browsers drop idle SSE streams. */
const SSE_PING_MS = 25_000;

/** @type {Readonly<Record<string, string>>} */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
});

/** Editor swap files, VCS metadata and the like must not trigger a rebuild. */
const IGNORED_EVENT = /(^|[\\/])(\.git|node_modules|\.DS_Store|\.#[^\\/]*)([\\/]|$)|(~|\.swp|\.swx|\.swo|\.tmp|\.part)$/;

/**
 * MIME type for a filename, defaulting to a safe binary type.
 * @param {string} file
 * @returns {string}
 */
export function contentTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * The live-reload client. Tiny on purpose: one EventSource, one reload.
 *
 * `open` also reloads once the stream comes *back*, which is what makes restarting the
 * dev server refresh every tab instead of leaving them stale.
 *
 * @param {string} eventsPath
 * @returns {string}
 */
export function liveReloadSnippet(eventsPath) {
  return `<script data-md2spa="live-reload">
(function () {
  if (typeof EventSource !== 'function') return;
  var es = new EventSource(${JSON.stringify(eventsPath)});
  var dropped = false;
  es.addEventListener('reload', function () { location.reload(); });
  es.addEventListener('open', function () { if (dropped) location.reload(); });
  es.addEventListener('error', function () { dropped = true; });
})();
</script>
`;
}

/**
 * Insert the snippet immediately before `</body>` (or append when there is no body tag).
 * @param {string} html
 * @param {string} snippet
 * @returns {string}
 */
export function injectLiveReload(html, snippet) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? html + snippet : html.slice(0, at) + snippet + html.slice(at);
}

/**
 * Map a request path onto a file inside `outDir`.
 *
 * Security: the resolved path is compared against the resolved root *after* `..` collapsing,
 * so `/../../etc/passwd`, `%2e%2e%2f` and NUL-byte tricks all land on `forbidden`.
 *
 * @param {string} outDir
 * @param {string} urlPath decoded-or-not request path (query already stripped)
 * @returns {{ kind: 'file'|'redirect'|'forbidden'|'missing', file?: string, location?: string }}
 */
export function resolveStaticPath(outDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { kind: 'forbidden' };
  }
  if (decoded.includes('\0')) return { kind: 'forbidden' };

  const root = path.resolve(outDir);
  const rel = decoded.startsWith('/') ? decoded : `/${decoded}`;
  const target = path.resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + path.sep)) return { kind: 'forbidden' };

  if (isDirectory(target)) {
    // Without the trailing slash every document-relative URL on the page would resolve
    // one level too high -- which is exactly the `base: "auto"` output we ship.
    if (!decoded.endsWith('/')) return { kind: 'redirect', location: `${rel}/` };
    const index = path.join(target, 'index.html');
    return isFile(index) ? { kind: 'file', file: index } : { kind: 'missing' };
  }

  if (isFile(target)) return { kind: 'file', file: target };

  // `cleanUrls: false` builds emit `/guide/install.html`; accept the extensionless form too.
  const withHtml = `${target}.html`;
  if (isFile(withHtml)) return { kind: 'file', file: withHtml };

  return { kind: 'missing' };
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Read back the source of every file a diagnostic points at, so `formatPretty` can print
 * the offending line with a caret underneath it. That excerpt is the whole point of the
 * linter, so it is worth the extra reads.
 *
 * @param {string} cwd
 * @param {Array<{ file?: string }>} diagnostics
 * @param {Map<string,string>} [seed] sources the caller already has
 * @returns {Map<string,string>}
 */
export function collectSources(cwd, diagnostics, seed) {
  const sources = seed instanceof Map ? new Map(seed) : new Map();
  const tried = new Set(sources.keys());

  for (const d of diagnostics || []) {
    const file = d && d.file;
    if (!file || tried.has(file)) continue;
    tried.add(file);
    const abs = path.resolve(cwd, ...String(file).split('/'));
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
      const text = fs.readFileSync(abs, 'utf8');
      sources.set(file, text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      // The file may be generated, deleted, or outside cwd -- the excerpt is optional.
    }
  }
  return sources;
}

/**
 * Collect directories to watch when the platform lacks `fs.watch({ recursive: true })`
 * (Linux before Node 20). Bounded so a pathological tree cannot exhaust file descriptors.
 *
 * @param {string} root
 * @param {number} [limit]
 * @returns {string[]}
 */
function collectWatchDirs(root, limit = MAX_WATCH_DIRS) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const queue = [root];
  // Explicit queue rather than recursion: bounded, and a symlink cycle cannot blow the stack.
  while (queue.length > 0 && found.length < limit) {
    const dir = queue.shift();
    found.push(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_EVENT.test(`/${entry.name}/`)) continue;
      queue.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/**
 * Watch a file or directory tree, preferring one recursive watcher.
 *
 * @param {string} target
 * @param {(name: string) => void} onEvent
 * @returns {{ close(): void, recursive: boolean }}
 */
function watchTree(target, onEvent) {
  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  const handler = (_type, name) => onEvent(typeof name === 'string' ? name : '');
  const add = (dir, opts) => {
    try {
      const w = fs.watch(dir, opts, handler);
      // A dead watcher (deleted directory) must not kill the dev server.
      w.on('error', () => {});
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };

  const dir = isDirectory(target);
  let recursive = false;
  if (!dir) {
    add(target, {});
  } else if (add(target, { recursive: true })) {
    recursive = true;
  } else {
    for (const sub of collectWatchDirs(target)) add(sub, {});
  }

  return {
    recursive,
    close() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      watchers.length = 0;
    },
  };
}

/**
 * Start the development server.
 *
 * Builds once, serves `outDir`, then watches content/static/theme/config and rebuilds with
 * `includeDrafts: true` on every change, pushing a reload to every connected browser.
 *
 * @param {{
 *   cwd?: string,
 *   config: object,
 *   port?: number,
 *   host?: string,
 *   open?: boolean,
 *   logger?: ReturnType<typeof createLogger>,
 *   color?: boolean,
 * }} options
 * @returns {Promise<{ url: string, port: number, host: string, rebuild: (reason?: string) => Promise<void>, close: () => Promise<void> }>}
 */
export async function startDevServer(options) {
  const {
    cwd = process.cwd(),
    config,
    port = 3000,
    host = '127.0.0.1',
    open = false,
    logger = createLogger(),
    color = supportsColor(),
  } = options || {};

  if (!config || typeof config !== 'object') {
    throw new TypeError('startDevServer requires a config object');
  }

  // Drafts and `_`-prefixed files are hidden from a production build but visible in dev,
  // where the whole point is to preview work in progress.
  const devConfig = { ...config, includeDrafts: true, dev: true };
  const { contentDir, outDir, staticDir } = resolveDirs(cwd, devConfig);
  const themeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme');

  // A non-auto base is baked into every emitted URL, so mirror it in the served paths.
  const basePrefix = devConfig.base && devConfig.base !== 'auto' && devConfig.base !== '/'
    ? devConfig.base
    : null;
  const eventsPath = basePrefix ? `${basePrefix.replace(/\/$/, '')}${EVENTS_PATH}` : EVENTS_PATH;
  const snippet = liveReloadSnippet(eventsPath);

  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let closed = false;

  // --- build -------------------------------------------------------------------------

  /** @type {((args: object) => Promise<any>)|null} */
  let buildSite = null;
  let building = false;
  let queued = false;

  const rebuild = async (reason = 'change', { fatalIfBroken = false } = {}) => {
    if (closed) return;
    if (building) {
      queued = true;
      return;
    }
    building = true;
    const startedAt = process.hrtime.bigint();
    try {
      if (!buildSite) ({ buildSite } = await import('./build/build.js'));
      const result = await buildSite({ cwd, config: devConfig, logger, includeDrafts: true });
      const diagnostics = (result && result.diagnostics) || [];
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

      if (diagnostics.length > 0) {
        const sources = collectSources(cwd, diagnostics, result && result.sources);
        process.stdout.write(
          `${formatDiagnostics(diagnostics, { sources, color, maxPerFile: 10 })}\n`,
        );
      }
      const counts = summarize(diagnostics);
      const fileCount = (result && result.files && result.files.length) || 0;
      logger.success(
        `${reason}: ${fileCount} file${fileCount === 1 ? '' : 's'} in ${ms.toFixed(0)}ms`
        + (counts.total ? ` (${counts.error} error, ${counts.warning} warning, ${counts.info} note)` : ''),
      );
      broadcast(clients, 'reload', { reason, errors: counts.error });
    } catch (err) {
      // A broken installation can never recover on the next keystroke, so let it out to
      // the CLI's error handler. Anything else is probably a bad page: stay up, keep the
      // previous output on disk, and give the next save a chance to fix it.
      if (fatalIfBroken && err && err.code === 'ERR_MODULE_NOT_FOUND') throw err;
      logger.error(`build failed: ${err && err.message ? err.message : String(err)}`);
      if (process.env.MD2SPA_DEBUG) logger.error(String(err && err.stack));
      broadcast(clients, 'error', { message: String(err && err.message) });
    } finally {
      building = false;
      if (queued) {
        queued = false;
        setTimeout(() => rebuild('change'), 0);
      }
    }
  };

  await rebuild('initial build', { fatalIfBroken: true });

  // --- http --------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    const rawPath = String(req.url || '/').split('?')[0].split('#')[0] || '/';
    let urlPath = rawPath;
    if (basePrefix) {
      if (urlPath === basePrefix.replace(/\/$/, '')) {
        redirect(res, basePrefix);
        return;
      }
      if (urlPath.startsWith(basePrefix)) urlPath = `/${urlPath.slice(basePrefix.length)}`;
      else if (urlPath === '/') {
        redirect(res, basePrefix);
        return;
      }
    }

    if (urlPath === EVENTS_PATH) {
      openEventStream(req, res, clients);
      return;
    }

    const resolved = resolveStaticPath(outDir, urlPath);

    if (resolved.kind === 'forbidden') {
      sendText(res, req, 403, 'Forbidden');
      return;
    }
    if (resolved.kind === 'redirect') {
      // Redirect using the *raw* path so percent-encoding survives the round trip.
      const query = String(req.url || '').slice(rawPath.length);
      redirect(res, `${rawPath}/${query}`);
      return;
    }
    if (resolved.kind === 'missing') {
      sendNotFound(res, req, outDir, snippet);
      return;
    }

    sendFile(res, req, resolved.file, 200, snippet);
  });

  server.on('clientError', (_err, socket) => {
    if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const boundPort = await listenWithFallback(server, port, host, PORT_ATTEMPTS);
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${boundPort}${basePrefix || '/'}`;

  if (boundPort !== port) logger.warn(`port ${port} was busy, using ${boundPort}`);
  logger.info('');
  logger.success(`dev server ready at ${url}`);
  logger.dim(`  serving  ${path.relative(cwd, outDir) || '.'}`);
  const watched = [contentDir, staticDir].filter((d) => isDirectory(d)).map((d) => path.relative(cwd, d) || '.');
  logger.dim(`  watching ${watched.join(', ') || '(nothing yet)'}`);
  logger.dim('  press Ctrl+C to stop');

  if (open) openBrowser(url);

  // --- watch -------------------------------------------------------------------------

  /** @type {Array<{ close(): void, recursive: boolean }>} */
  let watchers = [];
  /** @type {NodeJS.Timeout|null} */
  let debounce = null;

  const armWatchers = () => {
    for (const w of watchers) w.close();
    watchers = [];
    for (const dir of [contentDir, staticDir, themeDir]) {
      if (isDirectory(dir)) watchers.push(watchTree(dir, onFsEvent));
    }
    for (const name of ['md2spa.config.json', 'md2spa.config.js', 'md2spa.config.mjs', '.md2sparc.json']) {
      const file = path.join(cwd, name);
      if (isFile(file)) watchers.push(watchTree(file, onFsEvent));
    }
  };

  function onFsEvent(name) {
    if (closed) return;
    if (name && IGNORED_EVENT.test(name)) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      rebuild('rebuilt').then(() => {
        // Re-arm unconditionally: a folder added since the last arm is invisible to the
        // non-recursive fallback, and a config file replaced by rename (what most editors
        // do) leaves its single-file watcher pointing at a dead inode.
        if (!closed) armWatchers();
      });
    }, DEBOUNCE_MS);
  }

  armWatchers();

  // --- shutdown ----------------------------------------------------------------------

  const close = async () => {
    if (closed) return;
    closed = true;
    if (debounce) clearTimeout(debounce);
    for (const w of watchers) w.close();
    watchers = [];
    for (const res of clients) {
      try {
        res.end();
      } catch {
        // socket already gone
      }
    }
    clients.clear();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  };

  const onSignal = () => {
    process.stdout.write('\n');
    logger.dim('shutting down');
    close().then(() => process.exit(0), () => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { url, port: boundPort, host, rebuild, close };
}

/**
 * Try `port`, `port + 1`, ... until one is free.
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @param {number} attempts
 * @returns {Promise<number>}
 */
function listenWithFallback(server, port, host, attempts) {
  const first = Number.isFinite(port) ? Math.max(0, Math.trunc(port)) : 3000;
  const tryPort = (candidate, remaining) => new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE' && remaining > 1) {
        resolve(tryPort(candidate + 1, remaining - 1));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(candidate);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(candidate, host);
  });
  return tryPort(first, Math.max(1, attempts));
}

/**
 * @param {Set<import('node:http').ServerResponse>} clients
 * @param {string} event
 * @param {object} data
 */
function broadcast(clients, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Set<import('node:http').ServerResponse>} clients
 */
function openEventStream(req, res, clients) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // nginx and friends buffer unknown streams into uselessness without this.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  clients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, SSE_PING_MS);
  if (typeof ping.unref === 'function') ping.unref();

  const drop = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on('close', drop);
  req.on('error', drop);
  res.on('close', drop);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} location
 */
function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} req
 * @param {number} status
 * @param {string} body
 */
function sendText(res, req, status, body) {
  const buf = Buffer.from(`${body}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/**
 * Serve a file, injecting the live-reload snippet into HTML responses only.
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} req
 * @param {string} file
 * @param {number} status
 * @param {string} snippet
 */
function sendFile(res, req, file, status, snippet) {
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    sendText(res, req, 404, 'Not Found');
    return;
  }

  const type = contentTypeFor(file);
  if (type.startsWith('text/html')) {
    body = Buffer.from(injectLiveReload(body.toString('utf8'), snippet), 'utf8');
  }

  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    // Dev must never serve a stale asset; correctness beats a warm cache here.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} req
 * @param {string} outDir
 * @param {string} snippet
 */
function sendNotFound(res, req, outDir, snippet) {
  const page = path.join(path.resolve(outDir), '404.html');
  if (isFile(page)) {
    sendFile(res, req, page, 404, snippet);
    return;
  }
  const html = injectLiveReload(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>404 — not found</title></head><body><h1>404 — not found</h1>'
    + '<p>Nothing built at this path yet.</p></body></html>',
    snippet,
  );
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/**
 * Best-effort "open my browser". Never fatal: a headless CI box has no opener.
 * @param {string} url
 */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener available; the URL is printed above
  }
}
