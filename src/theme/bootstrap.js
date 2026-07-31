/**
 * Inline `<head>` snippets, exported as source strings.
 *
 * These two scripts are the only JavaScript that must run *synchronously, before paint*.
 * Everything else lives in `theme/app.js` and is deferred. They are strings rather than
 * files because a separate request would be a round-trip too late: the stylesheet would
 * already have painted the wrong theme, and 404.html would already have resolved its
 * assets against the wrong base.
 *
 * Both are written defensively -- `localStorage` throws outright in some privacy modes,
 * and a 404 page that throws is a 404 page with no stylesheet. Every statement is inside
 * a `try`. If either script fails the page still renders: the server-rendered default
 * theme stays applied and 404.html falls back to its build-time base.
 *
 * @module theme/bootstrap
 */

/** localStorage key holding the user's theme choice. Shared with `theme/app.js`. */
export const THEME_STORAGE_KEY = 'md2spa-theme';

/**
 * Synchronous no-FOUC theme bootstrap, inlined by `build/layout.js` into `<head>`
 * *before* the stylesheet link.
 *
 * Reads `localStorage['md2spa-theme']`, falls back to the `data-theme-default`
 * attribute that layout.js stamps on `<html>` (from `config.theme.defaultMode`), and
 * writes the result to `document.documentElement.dataset.theme`. The stylesheet keys
 * off `[data-theme]`, so the first paint is already correct.
 *
 * Deliberately kept under 600 bytes -- it is duplicated into every emitted page.
 *
 * @type {string}
 */
export const BOOTSTRAP_SOURCE = "(function(){try{var d=document.documentElement,t=null;"
  + "try{t=localStorage.getItem('md2spa-theme')}catch(e){}"
  + "if(t!=='light'&&t!=='dark'&&t!=='auto'){t=d.getAttribute('data-theme-default')||'auto'}"
  + "d.setAttribute('data-theme',t)}catch(e){}})();";

/**
 * Base-derivation bootstrap for `404.html`, inlined by `build/notfound.js`.
 *
 * A 404 document is the one page whose own URL tells you nothing: the server hands it
 * back for *any* missing path, at any depth, so neither `data-depth` (which depends on
 * where the document lives) nor a relative `../` count can be trusted. Instead the build
 * embeds the site's route list and this script recovers the base by finding the longest
 * known-route suffix of `location.pathname` -- `/proj/guide/install` ends with the known
 * route `/guide/install`, therefore the base is `/proj/`. With no match it falls back to
 * the build-time base (SPEC section 3).
 *
 * `build/notfound.js` must define these globals in an earlier inline script:
 *
 * ```js
 * window.__MD2SPA_ROUTES__ = ['/', '/guide/', '/guide/install/'];  // every known route
 * window.__MD2SPA_BASE__   = '/';                                  // config.base fallback
 * ```
 *
 * and mark every asset/route it cannot resolve at build time with a data attribute:
 *
 * ```html
 * <link rel="stylesheet" data-md2spa-asset="assets/style.abc12345.css">
 * <script data-md2spa-asset="assets/app.abc12345.js"></script>   <!-- re-injected as type=module -->
 * <img data-md2spa-asset="logo.svg" alt="">
 * <a data-md2spa-route="/guide/">Guide</a>
 * ```
 *
 * The script sets `href`/`src` on each of those, mirrors the theme bootstrap (a 404 must
 * not flash either), publishes the result as `data-base` on `<html>` plus
 * `window.__MD2SPA_SITE_BASE__`, and lets `theme/app.js` pick it up like any other page.
 *
 * @type {string}
 */
export const SPA_FALLBACK_SOURCE = [
  '(function(){',
  '  var d = document.documentElement;',
  '  var base = null;',
  '  try {',
  '    var routes = window.__MD2SPA_ROUTES__ || [];',
  '    var path = location.pathname;',
  '    try { path = decodeURIComponent(path); } catch (e) {}',
  '    var best = "";',
  '    for (var i = 0; i < routes.length; i++) {',
  '      var segs = String(routes[i] || "").replace(/^\\/+|\\/+$/g, "");',
  '      var cands = segs',
  '        ? ["/" + segs + "/index.html", "/" + segs + "/", "/" + segs + ".html", "/" + segs]',
  // The root route contributes only "/index.html". A bare "/" is a suffix of *every*
  // directory-shaped request, so it would match `/anything/missing/` and declare that
  // missing path to be the site base. Unmatched paths must fall through to the
  // build-time base instead (SPEC section 3).
  '        : ["/index.html"];',
  '      for (var c = 0; c < cands.length; c++) {',
  '        var suffix = cands[c];',
  '        if (suffix.length > best.length',
  '          && path.length >= suffix.length',
  '          && path.slice(path.length - suffix.length) === suffix) best = suffix;',
  '      }',
  '    }',
  '    if (best) base = path.slice(0, path.length - best.length) + "/";',
  '  } catch (e) {}',
  '  try {',
  '    if (!base) {',
  '      base = window.__MD2SPA_BASE__ || "/";',
  '      if (base === "auto") base = "/";',
  '    }',
  '    if (base.charAt(0) !== "/") base = "/" + base;',
  '    if (base.charAt(base.length - 1) !== "/") base += "/";',
  '    base = base.replace(/\\/{2,}/g, "/");',
  '    window.__MD2SPA_SITE_BASE__ = base;',
  '    d.setAttribute("data-base", base);',
  '    d.removeAttribute("data-depth");',
  '  } catch (e) {}',
  '  try {',
  '    var t = null;',
  '    try { t = localStorage.getItem("md2spa-theme"); } catch (e) {}',
  '    if (t !== "light" && t !== "dark" && t !== "auto") {',
  '      t = d.getAttribute("data-theme-default") || "auto";',
  '    }',
  '    d.setAttribute("data-theme", t);',
  '  } catch (e) {}',
  '  var repoint = function () {',
  '    try {',
  '      var assets = document.querySelectorAll("[data-md2spa-asset]");',
  '      for (var a = 0; a < assets.length; a++) {',
  '        var node = assets[a];',
  '        if (node.getAttribute("data-md2spa-done")) continue;',
  '        node.setAttribute("data-md2spa-done", "1");',
  '        var url = base + String(node.getAttribute("data-md2spa-asset") || "").replace(/^\\/+/, "");',
  '        var tag = node.tagName;',
  '        if (tag === "SCRIPT") {',
  '          var s = document.createElement("script");',
  '          s.type = "module";',
  '          s.src = url;',
  '          (document.head || d).appendChild(s);',
  '        } else if (tag === "LINK" || tag === "A") {',
  '          node.setAttribute("href", url);',
  '        } else {',
  '          node.setAttribute("src", url);',
  '        }',
  '      }',
  '      var links = document.querySelectorAll("[data-md2spa-route]");',
  '      for (var l = 0; l < links.length; l++) {',
  '        links[l].setAttribute("href",',
  '          base + String(links[l].getAttribute("data-md2spa-route") || "").replace(/^\\/+/, ""));',
  '      }',
  '    } catch (e) {}',
  '  };',
  // The 404 bootstrap is inlined *before* the stylesheet, the app script and the entire
  // body, so on first execution none of the tagged elements exist yet and a single
  // synchronous pass would silently repoint nothing. Run once now (harmless, and correct
  // should the markup order ever change) and again once parsing has finished.
  '  repoint();',
  '  try {',
  '    if (document.readyState === "loading") {',
  '      document.addEventListener("DOMContentLoaded", repoint);',
  '    }',
  '  } catch (e) {}',
  '})();',
].join('\n');

/**
 * Convenience wrapper: the full inline script body for a 404 page, globals included.
 * Returns script *contents* only -- the caller wraps it in `<script>` so it controls
 * nonce/CSP attributes.
 *
 * @param {{ routes?: string[], base?: string }} [options]
 * @param {string[]} [options.routes] every known site route, e.g. `['/', '/guide/']`
 * @param {string} [options.base] build-time fallback base (`config.base`), `'auto'` allowed
 * @returns {string}
 */
export function renderSpaFallback(options = {}) {
  const routes = Array.isArray(options.routes) ? options.routes : [];
  const base = typeof options.base === 'string' ? options.base : '/';
  // JSON.stringify is the safe encoder here: the values are plain strings, and `</script>`
  // inside a route would otherwise close the tag early.
  const encode = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  return `window.__MD2SPA_ROUTES__=${encode(routes)};`
    + `window.__MD2SPA_BASE__=${encode(base)};\n`
    + SPA_FALLBACK_SOURCE;
}
