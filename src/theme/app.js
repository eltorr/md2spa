/**
 * The client-side runtime: router, sidebar tree, search, scrollspy, theme, drawer.
 *
 * This module is shipped verbatim to the browser -- it imports nothing and touches no
 * Node API. It is loaded with `type="module"` (therefore deferred), which means every
 * page has already rendered by the time a single line here executes.
 *
 * **That ordering is the design.** Every page is fully pre-rendered and internally
 * linked; this file only makes navigation faster and the chrome richer. If it 404s,
 * fails to parse, or throws, the site is still a complete multi-page documentation site.
 * To hold that guarantee each subsystem is initialised inside its own `safely()` wrapper,
 * so a missing element in the sidebar cannot take down search, and any router failure
 * degrades to `location.assign()` -- a plain browser navigation.
 *
 * @module theme/app
 */

/* ------------------------------------------------------------------ constants */

/** Shared with `theme/bootstrap.js` -- do not rename without updating both. */
const THEME_KEY = 'md2spa-theme';
/** sessionStorage key for sidebar group expansion. */
const NAV_KEY = 'md2spa-nav';
/** Theme cycle order for the toggle button. */
const THEMES = ['auto', 'light', 'dark'];
/** Only show the progress bar once a fetch is slow enough for a human to notice. */
const PROGRESS_DELAY = 200;
/** Hard cap on rendered search results; more than this is a worse UX, not a better one. */
const MAX_RESULTS = 30;
/** Tokens indexed per page body. Bounds worst-case query cost on a pathological page. */
const MAX_BODY_TOKENS = 6000;
/** Payload cache ceiling, so a long session cannot grow without bound. */
const CACHE_LIMIT = 40;
/** Characters of context either side of a search hit. */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 90;

/* ------------------------------------------------------------------ tiny helpers */

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element|null}
 */
function $(selector, root) {
  return (root || document).querySelector(selector);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element[]}
 */
function $$(selector, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(selector));
}

/**
 * Run an initialiser in isolation. A subsystem that throws must never prevent the
 * others from starting -- that is the whole progressive-enhancement contract.
 * @param {string} name
 * @param {() => void} fn
 */
function safely(name, fn) {
  try {
    fn();
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[md2spa] ${name} disabled:`, err);
    }
  }
}

/**
 * Normalise a route the same way `util/path.js` does on the build side.
 * @param {string} route
 * @returns {string}
 */
function normalizeRoute(route) {
  let r = String(route == null ? '/' : route).replace(/\\/g, '/');
  if (r.charAt(0) !== '/') r = `/${r}`;
  r = r.replace(/\/{2,}/g, '/');
  if (r.charAt(r.length - 1) !== '/') r += '/';
  return r;
}

/**
 * Route -> SPA payload path, relative to the site root. Must stay in step with
 * `routeToPayloadPath()` in `util/path.js` or every fetch 404s.
 *
 * The payload tree mirrors the route tree, so this is pure concatenation -- no sanitising,
 * no lookup table, and no way for two distinct routes to land on the same file.
 *
 * @param {string} route
 * @returns {string}
 */
function payloadPathFor(route) {
  const segments = normalizeRoute(route).split('/').filter(Boolean);
  return segments.length === 0 ? '_spa/index.json' : `_spa/${segments.join('/')}/index.json`;
}

/**
 * Split text into lowercase search tokens. Unicode-aware so accented and non-Latin
 * documentation is searchable; the character class has no nesting, so no backtracking.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
function tokenize(text, limit) {
  const parts = String(text || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    out.push(parts[i]);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** True when the user has asked for less movement. Re-read on every use; it can change. */
function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

/** @returns {ScrollBehavior} */
function scrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

/**
 * sessionStorage/localStorage access that cannot throw. Private browsing modes make
 * every storage call a potential exception, including the *read*.
 * @param {Storage|null} store
 * @param {string} key
 * @returns {string|null}
 */
function readStore(store, key) {
  try {
    return store ? store.getItem(key) : null;
  } catch (err) {
    return null;
  }
}

/**
 * @param {Storage|null} store
 * @param {string} key
 * @param {string} value
 */
function writeStore(store, key, value) {
  try {
    if (store) store.setItem(key, value);
  } catch (err) {
    /* quota exceeded or storage disabled -- state simply does not persist */
  }
}

/** @returns {Storage|null} */
function localStore() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

/** @returns {Storage|null} */
function sessionStore() {
  try {
    return window.sessionStorage;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ shared state */

/**
 * @typedef {Object} SiteInfo
 * @property {string} href absolute URL of the site root, always trailing-slashed
 * @property {string} path decoded pathname of the site root
 * @property {string} origin
 * @property {number} depth
 * @property {boolean} relative true when URLs in the document are document-relative
 * @property {boolean} cleanUrls
 */

/** @type {SiteInfo} */
let site;

/** Callbacks re-run after every SPA content swap. */
const afterSwap = [];

/** @param {() => void} fn */
function onAfterSwap(fn) {
  afterSwap.push(fn);
}

function runAfterSwap() {
  for (let i = 0; i < afterSwap.length; i += 1) {
    safely('after-swap hook', afterSwap[i]);
  }
}

/**
 * Resolve the site base. `data-base` wins when layout.js emitted absolute URLs;
 * otherwise climb `data-depth` directories from the current document (`base: "auto"`).
 * Keeping an absolute `href` rather than only a pathname is what lets the site work
 * over `file://` too.
 *
 * @returns {SiteInfo}
 */
function resolveSite() {
  const root = document.documentElement;
  // `base: "auto"` is stamped verbatim on <html> as `data-base="auto"`. That is a mode
  // name, not a URL -- resolving it would yield `<current dir>/auto/` and break every
  // route comparison, the router and the search index fetch. Only an actual path counts
  // as "declared"; everything else falls through to the `data-depth` climb below.
  const rawBase = root.getAttribute('data-base');
  const declared = rawBase && rawBase !== 'auto' ? rawBase : null;
  const rawDepth = parseInt(root.getAttribute('data-depth') || '0', 10);
  const depth = Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : 0;

  let href;
  try {
    href = declared
      ? new URL(declared, location.href).href
      : new URL(depth > 0 ? '../'.repeat(depth) : './', location.href).href;
  } catch (err) {
    href = location.href;
  }
  if (href.charAt(href.length - 1) !== '/') href += '/';

  let path = '/';
  let origin = '';
  try {
    const url = new URL(href);
    origin = url.origin;
    try {
      path = decodeURIComponent(url.pathname);
    } catch (err) {
      path = url.pathname;
    }
  } catch (err) {
    /* keep the defaults */
  }

  return {
    href,
    path,
    origin,
    depth,
    relative: !declared,
    cleanUrls: root.getAttribute('data-clean-urls') !== 'false',
  };
}

/**
 * Map a same-origin URL back to a site route, undoing whichever `cleanUrls` shape the
 * build emitted. Returns null when the URL is outside the site.
 * @param {URL} url
 * @returns {string|null}
 */
function routeFromUrl(url) {
  if (site.origin && url.origin !== site.origin) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch (err) {
    path = url.pathname;
  }
  if (path.indexOf(site.path) !== 0) return null;
  let rest = path.slice(site.path.length);
  rest = rest.replace(/(^|\/)index\.html?$/i, '$1');
  rest = rest.replace(/\.html?$/i, '/');
  return normalizeRoute(rest);
}

/**
 * Absolute URL for a route. The sidebar already holds a correct href for every page,
 * so prefer that -- it is authoritative for `cleanUrls`, redirects and casing. The
 * constructed form is only a fallback for routes missing from the nav (`nav: false`).
 * @param {string} route
 * @returns {string}
 */
function hrefForRoute(route) {
  const normalized = normalizeRoute(route);
  const known = navIndex.get(normalized);
  if (known) return known.href;
  const segments = normalized.split('/').filter(Boolean);
  let rel = segments.length ? `${segments.join('/')}/` : '';
  if (!site.cleanUrls && segments.length) rel = `${segments.join('/')}.html`;
  try {
    return new URL(rel, site.href).href;
  } catch (err) {
    return site.href + rel;
  }
}

/** route -> sidebar anchor. Built once; the sidebar survives SPA swaps. */
const navIndex = new Map();

function buildNavIndex() {
  navIndex.clear();
  const links = $$('.nav-link');
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    try {
      const route = routeFromUrl(new URL(link.href, location.href));
      if (route && !navIndex.has(route)) navIndex.set(route, link);
    } catch (err) {
      /* a malformed href simply does not participate in the index */
    }
  }
}

/**
 * Under `base: "auto"` every URL in the shell is relative to *this* document's depth.
 * The moment the router rewrites the address bar those relative URLs would resolve
 * against the new depth and break. Freezing them to absolute up front costs one pass
 * and removes the entire class of bug.
 */
function absolutizeShell() {
  if (!site.relative) return;
  const anchors = $$('a[href]');
  for (let i = 0; i < anchors.length; i += 1) {
    const raw = anchors[i].getAttribute('href') || '';
    if (!raw || raw.charAt(0) === '#' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
    anchors[i].setAttribute('href', anchors[i].href);
  }
  const images = $$('img[src]');
  for (let i = 0; i < images.length; i += 1) {
    const raw = images[i].getAttribute('src') || '';
    if (!raw || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
    images[i].setAttribute('src', images[i].src);
  }
}

/* ------------------------------------------------------------------ live region */

/** @type {HTMLElement|null} */
let liveRegion = null;

/**
 * A polite live region for route announcements. Styled inline rather than via a
 * stylesheet class so it still works if the CSS fails to load.
 */
function initLiveRegion() {
  liveRegion = document.createElement('div');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'sr-live';
  liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;'
    + 'overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';
  document.body.appendChild(liveRegion);
}

/**
 * @param {string} message
 */
function announce(message) {
  if (!liveRegion || !message) return;
  liveRegion.textContent = '';
  // Assistive tech only reports a *change*; a tick of empty content guarantees one.
  setTimeout(() => {
    if (liveRegion) liveRegion.textContent = message;
  }, 60);
}

/* ------------------------------------------------------------------ theme */

/** @returns {string} */
function currentTheme() {
  const root = document.documentElement;
  const applied = root.getAttribute('data-theme');
  if (THEMES.indexOf(applied) >= 0) return applied;
  const fallback = root.getAttribute('data-theme-default');
  return THEMES.indexOf(fallback) >= 0 ? fallback : 'auto';
}

/**
 * @param {Element} button
 */
function describeTheme(button) {
  const theme = currentTheme();
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const names = { auto: 'system', light: 'light', dark: 'dark' };
  button.setAttribute('aria-label', `Theme: ${names[theme]}. Switch to ${names[next]} theme`);
  button.setAttribute('title', `Theme: ${names[theme]}`);
  button.setAttribute('data-theme-state', theme);
  const label = $('.theme-toggle__label', button);
  if (label) label.textContent = names[theme];
}

/**
 * @param {string} theme
 * @param {Element|null} button
 */
function applyTheme(theme, button) {
  const value = THEMES.indexOf(theme) >= 0 ? theme : 'auto';
  document.documentElement.setAttribute('data-theme', value);
  writeStore(localStore(), THEME_KEY, value);
  if (button) describeTheme(button);
}

function initTheme() {
  const button = $('.theme-toggle');
  if (!button) return;
  describeTheme(button);
  button.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    applyTheme(next, button);
  });
  // Keep tabs in sync when the choice changes in another window.
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_KEY || !event.newValue) return;
    if (THEMES.indexOf(event.newValue) < 0) return;
    document.documentElement.setAttribute('data-theme', event.newValue);
    describeTheme(button);
  });
}

/* ------------------------------------------------------------------ code copy */

/**
 * Inject a copy button into every highlighted code figure that lacks one. Runs on load
 * and again after each SPA swap; the `has` check keeps it idempotent.
 * @param {ParentNode} [root]
 */
function injectCopyButtons(root) {
  const figures = $$('figure.code', root || document);
  for (let i = 0; i < figures.length; i += 1) {
    const figure = figures[i];
    if ($('.code__copy', figure)) continue;
    if (!$('.code__pre, pre', figure)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code__copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    figure.appendChild(button);
  }
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for insecure origins and file://, where the async clipboard is unavailable.
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    if (ok) resolve();
    else reject(new Error('copy unsupported'));
  });
}

function initCodeCopy() {
  injectCopyButtons(document);
  onAfterSwap(() => injectCopyButtons(document));

  // One delegated listener covers buttons injected after every future swap.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const button = target.closest('.code__copy');
    if (!button) return;
    const figure = button.closest('figure.code');
    const pre = figure && $('.code__pre, pre', figure);
    if (!pre) return;
    event.preventDefault();
    copyText(pre.textContent || '').then(() => {
      button.textContent = 'Copied';
      button.classList.add('is-copied');
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('is-copied');
      }, 1600);
    }, () => {
      button.textContent = 'Failed';
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    });
  });
}

/* ------------------------------------------------------------------ TOC scrollspy */

/** @type {IntersectionObserver|null} */
let tocObserver = null;

/**
 * @param {Element|null} active
 * @param {Element[]} links
 */
function setActiveTocLink(active, links) {
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const on = link === active;
    link.classList.toggle('toc__link--active', on);
    if (on) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function buildScrollspy() {
  if (tocObserver) {
    tocObserver.disconnect();
    tocObserver = null;
  }
  if (typeof IntersectionObserver !== 'function') return;

  const links = $$('.toc__link');
  if (!links.length) return;

  /** @type {Map<Element, Element>} */
  const linkFor = new Map();
  const targets = [];
  for (let i = 0; i < links.length; i += 1) {
    const href = links[i].getAttribute('href') || '';
    if (href.charAt(0) !== '#') continue;
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch (err) {
      /* keep the raw form */
    }
    const heading = id && document.getElementById(id);
    if (!heading) continue;
    linkFor.set(heading, links[i]);
    targets.push(heading);
  }
  if (!targets.length) return;

  /** @type {Set<Element>} */
  const visible = new Set();
  tocObserver = new IntersectionObserver((entries) => {
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].isIntersecting) visible.add(entries[i].target);
      else visible.delete(entries[i].target);
    }
    let best = null;
    for (let i = 0; i < targets.length; i += 1) {
      if (visible.has(targets[i])) { best = targets[i]; break; }
    }
    if (!best) {
      // Mid-section: nothing is intersecting the top band, so take the last heading
      // that has already scrolled past it.
      for (let i = 0; i < targets.length; i += 1) {
        if (targets[i].getBoundingClientRect().top < 120) best = targets[i];
      }
    }
    setActiveTocLink(best ? linkFor.get(best) : null, links);
  }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

  for (let i = 0; i < targets.length; i += 1) tocObserver.observe(targets[i]);
}

function initScrollspy() {
  buildScrollspy();
  onAfterSwap(buildScrollspy);

  // In-page anchors (TOC entries and heading permalinks) scroll smoothly, move focus
  // to the heading so keyboard and screen-reader users follow along, and update the
  // address bar without adding a history entry -- Back should leave the page, not
  // walk every heading the reader visited.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!target || !target.closest) return;
    const link = target.closest('.toc__link, a.anchor');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (href.charAt(0) !== '#') return;
    const heading = document.getElementById(decodeHash(href));
    if (!heading) return;
    event.preventDefault();
    heading.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    heading.setAttribute('tabindex', '-1');
    try {
      heading.focus({ preventScroll: true });
    } catch (err) {
      heading.focus();
    }
    try {
      history.replaceState(history.state, '', href);
    } catch (err) {
      /* opaque origins reject replaceState; the scroll already happened */
    }
  });
}

/* ------------------------------------------------------------------ sidebar tree */

/** Original label text per nav link, captured before the filter rewrites it. */
const originalLabels = new WeakMap();
/** Expansion state captured before a filter forced groups open. */
const preFilterState = new WeakMap();

/**
 * @param {Element} group
 * @returns {Element|null}
 */
function groupToggle(group) {
  const toggle = $('.nav-group__toggle', group);
  return toggle && toggle.closest('.nav-group') === group ? toggle : null;
}

/**
 * @param {Element} group
 * @returns {Element|null}
 */
function groupList(group) {
  const list = $('.nav-group__list', group);
  return list && list.closest('.nav-group') === group ? list : null;
}

/**
 * @param {Element} group
 * @returns {boolean}
 */
function isExpanded(group) {
  if (group.tagName === 'DETAILS') return !!group.open;
  const toggle = groupToggle(group);
  if (!toggle) return true;
  return toggle.getAttribute('aria-expanded') !== 'false';
}

/**
 * Drive whichever disclosure the layout used. `<details>` keeps working with JS off,
 * so it is the expected form; the `<button aria-expanded>` branch is here so the
 * runtime does not silently break if layout.js switches.
 * @param {Element} group
 * @param {boolean} open
 */
function setExpanded(group, open) {
  if (group.tagName === 'DETAILS') {
    group.open = open;
  } else {
    const list = groupList(group);
    if (list) list.hidden = !open;
  }
  const toggle = groupToggle(group);
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  group.classList.toggle('is-open', open);
}

/**
 * Stable identity for a group across reloads. `data-nav-key` from layout.js is
 * preferred; the label chain is a serviceable fallback.
 * @param {Element} group
 * @returns {string}
 */
function groupKey(group) {
  if (group.getAttribute('data-nav-key')) return group.getAttribute('data-nav-key');
  const parts = [];
  let node = group;
  let guard = 0;
  while (node && guard < 64) {
    guard += 1;
    const toggle = groupToggle(node);
    if (toggle) parts.unshift((toggle.textContent || '').trim().slice(0, 40));
    node = node.parentElement ? node.parentElement.closest('.nav-group') : null;
  }
  return parts.join('/');
}

/** @returns {Record<string, boolean>} */
function readNavState() {
  const raw = readStore(sessionStore(), NAV_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** @param {Record<string, boolean>} state */
function writeNavState(state) {
  writeStore(sessionStore(), NAV_KEY, JSON.stringify(state));
}

/**
 * True when the element is reachable by keyboard: not hidden, not filtered out, and
 * not inside a collapsed group.
 * @param {Element} el
 * @returns {boolean}
 */
function isNavItemVisible(el) {
  if (el.hidden || el.closest('[hidden]')) return false;
  let node = el.parentElement;
  let guard = 0;
  while (node && guard < 128) {
    guard += 1;
    if (node.classList && node.classList.contains('nav-group__list')) {
      const group = node.closest('.nav-group');
      if (group && !isExpanded(group)) return false;
    }
    if (node === document.body) break;
    node = node.parentElement;
  }
  return true;
}

/**
 * @param {Element} tree
 * @returns {Element[]}
 */
function visibleTreeItems(tree) {
  return $$('.nav-link, .nav-group__toggle', tree).filter(isNavItemVisible);
}

/**
 * Keep every navigation entry reachable by Tab.
 *
 * This used to be a roving tabindex, which is what `role="tree"` requires -- but the
 * sidebar is a nav landmark of nested lists, not a tree widget, and a roving tabindex
 * there silently drops all but one link out of the tab order. Links and `<summary>` are
 * natively focusable, so the arrow-key handlers work without any tabindex at all; this
 * only has to undo anything an earlier build left behind.
 *
 * @param {Element} tree
 * @param {Element|null} _focused unused; kept so the call sites stay readable
 */
function setRovingTabindex(tree, _focused) {
  const items = $$('.nav-link, .nav-group__toggle', tree);
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].getAttribute('tabindex') !== null) items[i].removeAttribute('tabindex');
  }
}

/**
 * @param {Element} tree
 * @param {Element} item
 */
function focusTreeItem(tree, item) {
  if (!item) return;
  setRovingTabindex(tree, item);
  item.focus();
}

/**
 * Scroll the active entry into the sidebar's own scroll box without moving the page.
 * @param {Element} sidebar
 * @param {Element} active
 */
function revealInSidebar(sidebar, active) {
  const box = $('.sidebar__inner', sidebar) || sidebar;
  const boxRect = box.getBoundingClientRect();
  const itemRect = active.getBoundingClientRect();
  if (itemRect.top >= boxRect.top && itemRect.bottom <= boxRect.bottom) return;
  const delta = (itemRect.top - boxRect.top) - (box.clientHeight / 2) + (itemRect.height / 2);
  const top = Math.max(0, box.scrollTop + delta);
  if (box.scrollTo) box.scrollTo({ top, behavior: scrollBehavior() });
  else box.scrollTop = top;
}

/**
 * Mark the sidebar entry for `route` as current and expand its ancestors.
 * @param {string} route
 * @param {{ reveal?: boolean }} [options]
 */
function updateSidebarActive(route, options) {
  const sidebar = $('.sidebar');
  if (!sidebar) return;
  const links = $$('.nav-link', sidebar);
  const active = navIndex.get(normalizeRoute(route)) || null;

  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    link.classList.remove('nav-link--active', 'nav-link--ancestor');
    link.removeAttribute('aria-current');
  }
  if (!active) return;

  active.classList.add('nav-link--active');
  active.setAttribute('aria-current', 'page');

  // Ancestors: expand them, and give the ancestor *links* the subtler marker.
  let group = active.parentElement ? active.parentElement.closest('.nav-group') : null;
  let guard = 0;
  while (group && guard < 64) {
    guard += 1;
    setExpanded(group, true);
    const toggle = groupToggle(group);
    if (toggle) toggle.classList.add('is-ancestor');
    // A group that also has its own landing page carries the subtler ancestor marker.
    const ownLink = $(':scope > .nav-link', group);
    if (ownLink && ownLink !== active) ownLink.classList.add('nav-link--ancestor');
    group = group.parentElement ? group.parentElement.closest('.nav-group') : null;
  }
  if (!options || options.reveal !== false) revealInSidebar(sidebar, active);
}

/**
 * @param {Element} link
 * @returns {string}
 */
function labelText(link) {
  if (!originalLabels.has(link)) {
    const label = $('.nav-link__label', link);
    originalLabels.set(link, ((label || link).textContent || '').trim());
  }
  return originalLabels.get(link);
}

/**
 * Rewrite a nav label with the matched span wrapped in `<mark>`. Built entirely from
 * text nodes -- the label is author-supplied and must never be parsed as HTML.
 * @param {Element} link
 * @param {string} query
 */
function highlightLabel(link, query) {
  const host = $('.nav-link__label', link) || link;
  // Only safe to rewrite a container whose children are pure text.
  if (host === link && link.firstElementChild) {
    link.classList.toggle('is-match', !!query);
    return;
  }
  const text = labelText(link);
  host.textContent = '';
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) {
    host.appendChild(document.createTextNode(text));
    link.classList.remove('is-match');
    return;
  }
  host.appendChild(document.createTextNode(text.slice(0, at)));
  const mark = document.createElement('mark');
  mark.className = 'nav-link__match';
  mark.textContent = text.slice(at, at + query.length);
  host.appendChild(mark);
  host.appendChild(document.createTextNode(text.slice(at + query.length)));
  link.classList.add('is-match');
}

/**
 * @param {Element} el
 * @returns {Element}
 */
function navRow(el) {
  return el.closest('.nav-item') || el.closest('li') || el;
}

/**
 * Live-filter the tree. A 100-page sidebar is unusable without it, so it has to keep
 * the result navigable: matching leaves stay, their ancestors stay and open, and
 * everything else is hidden rather than removed (so clearing restores instantly).
 * @param {Element} tree
 * @param {string} raw
 */
function applyFilter(tree, raw) {
  const query = String(raw || '').trim().toLowerCase();
  const links = $$('.nav-link', tree);
  const groups = $$('.nav-group', tree);

  if (!query) {
    for (let i = 0; i < links.length; i += 1) {
      navRow(links[i]).hidden = false;
      highlightLabel(links[i], '');
    }
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      navRow(group).hidden = false;
      group.hidden = false;
      if (preFilterState.has(group)) {
        setExpanded(group, preFilterState.get(group));
        preFilterState.delete(group);
      }
    }
    tree.classList.remove('is-filtered');
    setRovingTabindex(tree, null);
    return;
  }

  tree.classList.add('is-filtered');
  const keep = new Set();

  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const hit = labelText(link).toLowerCase().indexOf(query) >= 0;
    highlightLabel(link, hit ? query : '');
    navRow(link).hidden = !hit;
    if (hit) keep.add(link);
  }

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const toggle = groupToggle(group);
    const labelHit = toggle
      && (toggle.textContent || '').toLowerCase().indexOf(query) >= 0;
    if (labelHit) keep.add(group);
  }

  // A group survives if it, or anything beneath it, matched.
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    const hasVisibleChild = $$('.nav-link, .nav-group', group)
      .some((child) => keep.has(child));
    const visible = keep.has(group) || hasVisibleChild;
    group.hidden = !visible;
    navRow(group).hidden = !visible;
    if (visible) {
      keep.add(group);
      if (!preFilterState.has(group)) preFilterState.set(group, isExpanded(group));
      setExpanded(group, true);
      // A group whose own label matched shows all of its children.
      if (keep.has(group) && !hasVisibleChild) {
        const children = $$('.nav-link', group);
        for (let c = 0; c < children.length; c += 1) navRow(children[c]).hidden = false;
      }
    }
  }

  setRovingTabindex(tree, null);
}

/**
 * @param {Element} tree
 * @param {KeyboardEvent} event
 */
function handleTreeKeydown(tree, event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const item = target.closest('.nav-link, .nav-group__toggle');
  if (!item || !tree.contains(item)) return;

  const items = visibleTreeItems(tree);
  const index = items.indexOf(item);
  const group = item.classList.contains('nav-group__toggle')
    ? item.closest('.nav-group')
    : null;

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusTreeItem(tree, items[Math.min(items.length - 1, index + 1)]);
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusTreeItem(tree, items[Math.max(0, index - 1)]);
      break;
    case 'ArrowRight':
      event.preventDefault();
      if (group && !isExpanded(group)) {
        setExpanded(group, true);
        persistGroup(group);
        setRovingTabindex(tree, item);
      } else {
        focusTreeItem(tree, visibleTreeItems(tree)[index + 1]);
      }
      break;
    case 'ArrowLeft': {
      event.preventDefault();
      if (group && isExpanded(group)) {
        setExpanded(group, false);
        persistGroup(group);
        setRovingTabindex(tree, item);
        break;
      }
      const parent = item.parentElement && item.parentElement.closest('.nav-group');
      const parentToggle = parent && groupToggle(parent);
      if (parentToggle) focusTreeItem(tree, parentToggle);
      break;
    }
    case 'Home':
      event.preventDefault();
      focusTreeItem(tree, items[0]);
      break;
    case 'End':
      event.preventDefault();
      focusTreeItem(tree, items[items.length - 1]);
      break;
    default:
      break;
  }
}

/**
 * @param {Element} group
 */
function persistGroup(group) {
  const state = readNavState();
  state[groupKey(group)] = isExpanded(group);
  writeNavState(state);
}

function initSidebar() {
  const sidebar = $('.sidebar');
  if (!sidebar) return;
  const tree = $('.nav-tree', sidebar);
  if (!tree) return;

  // Restore persisted expansion before anything measures visibility.
  const stored = readNavState();
  const groups = $$('.nav-group', tree);
  for (let i = 0; i < groups.length; i += 1) {
    const key = groupKey(groups[i]);
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      setExpanded(groups[i], !!stored[key]);
    } else {
      // Sync aria-expanded with the server-rendered `<details open>` state.
      setExpanded(groups[i], isExpanded(groups[i]));
    }
  }

  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].tagName !== 'DETAILS') continue;
    groups[i].addEventListener('toggle', () => {
      const toggle = groupToggle(groups[i]);
      if (toggle) toggle.setAttribute('aria-expanded', groups[i].open ? 'true' : 'false');
      groups[i].classList.toggle('is-open', groups[i].open);
      persistGroup(groups[i]);
    });
  }

  // `<summary>` toggles itself; only a button variant needs a handler.
  tree.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const toggle = target.closest('.nav-group__toggle');
    if (!toggle || toggle.tagName === 'SUMMARY') return;
    const group = toggle.closest('.nav-group');
    if (!group) return;
    event.preventDefault();
    setExpanded(group, !isExpanded(group));
    persistGroup(group);
    setRovingTabindex(tree, toggle);
  });

  tree.addEventListener('keydown', (event) => handleTreeKeydown(tree, event));
  tree.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const item = target.closest('.nav-link, .nav-group__toggle');
    if (item) setRovingTabindex(tree, item);
  });

  const filterHost = $('.sidebar__filter', sidebar);
  const filterInput = filterHost
    && (filterHost.tagName === 'INPUT' ? filterHost : $('input', filterHost));
  if (filterInput) {
    filterInput.addEventListener('input', () => applyFilter(tree, filterInput.value));
    filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && filterInput.value) {
        event.preventDefault();
        event.stopPropagation();
        filterInput.value = '';
        applyFilter(tree, '');
      }
      if (event.key === 'ArrowDown') {
        const first = visibleTreeItems(tree)[0];
        if (first) {
          event.preventDefault();
          focusTreeItem(tree, first);
        }
      }
    });
  }

  const route = document.body.getAttribute('data-route') || routeFromUrl(new URL(location.href)) || '/';
  updateSidebarActive(route);
  setRovingTabindex(tree, null);

  onAfterSwap(() => {
    const current = document.body.getAttribute('data-route') || '/';
    updateSidebarActive(current);
    setRovingTabindex(tree, null);
  });
}

/* ------------------------------------------------------------------ focus + scroll lock */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea,'
  + ' summary, [tabindex]:not([tabindex="-1"])';

/**
 * @param {Element} container
 * @returns {HTMLElement[]}
 */
function focusableIn(container) {
  return $$(FOCUSABLE, container).filter((el) => !el.hidden
    && !el.closest('[hidden]')
    && (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement));
}

/**
 * Constrain Tab to `container` until the returned function is called.
 * @param {Element} container
 * @returns {() => void}
 */
function trapFocus(container) {
  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusableIn(container);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown, true);
  return () => document.removeEventListener('keydown', onKeydown, true);
}

let scrollLocks = 0;

/**
 * Lock body scrolling while an overlay is up, compensating for the vanished scrollbar
 * so the page behind does not shift (SPEC section 7: "No layout shift").
 */
function lockScroll() {
  scrollLocks += 1;
  if (scrollLocks > 1) return;
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = 'hidden';
  if (gap > 0) document.body.style.paddingRight = `${gap}px`;
}

function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks > 0) return;
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
}

/**
 * `inert` where supported, `aria-hidden` + tabindex removal is not worth emulating --
 * the focus trap already handles keyboard containment.
 * @param {Element[]} elements
 * @param {boolean} on
 */
function setInert(elements, on) {
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (!el) continue;
    if ('inert' in el) el.inert = on;
    if (on) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
  }
}

/** @returns {Element} */
function ensureOverlay() {
  let overlay = $('.overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.hidden = true;
    document.body.appendChild(overlay);
  }
  return overlay;
}

/* ------------------------------------------------------------------ mobile drawer */

/** @type {(() => void)|null} */
let releaseDrawerFocus = null;
let drawerOpen = false;

/** @type {{ open: () => void, close: () => void }|null} */
let drawer = null;

function initDrawer() {
  const toggle = $('.nav-toggle');
  const sidebar = $('.sidebar');
  if (!toggle || !sidebar) return;
  const overlay = ensureOverlay();
  const background = [$('.content'), $('.toc'), $('.site-footer')];

  const open = () => {
    if (drawerOpen) return;
    drawerOpen = true;
    document.documentElement.setAttribute('data-nav-open', 'true');
    document.body.classList.add('nav-open');
    sidebar.classList.add('is-open');
    overlay.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    setInert(background, true);
    lockScroll();
    releaseDrawerFocus = trapFocus(sidebar);
    const first = focusableIn(sidebar)[0];
    if (first) first.focus();
  };

  const close = () => {
    if (!drawerOpen) return;
    drawerOpen = false;
    document.documentElement.removeAttribute('data-nav-open');
    document.body.classList.remove('nav-open');
    sidebar.classList.remove('is-open');
    if (!searchOpen) overlay.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    setInert(background, false);
    unlockScroll();
    if (releaseDrawerFocus) {
      releaseDrawerFocus();
      releaseDrawerFocus = null;
    }
    toggle.focus();
  };

  drawer = { open, close };
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    if (drawerOpen) close();
    else open();
  });
  overlay.addEventListener('click', () => {
    if (drawerOpen) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) {
      event.preventDefault();
      close();
    }
  });

  // A drawer left open across a route change would hide the page the user just picked.
  onAfterSwap(() => {
    if (drawerOpen) close();
  });
}

/* ------------------------------------------------------------------ search */

/**
 * @typedef {Object} SearchEntry
 * @property {string} route
 * @property {string} title
 * @property {string} description
 * @property {Array<{ id: string, text: string }>} headings
 * @property {string} body
 * @property {Set<string>} titleSet
 * @property {string[]} titleList
 * @property {Set<string>} headingSet
 * @property {string[]} headingList
 * @property {Set<string>} bodySet
 * @property {string[]} bodyList
 */

/** Field weights. Title beats headings beats body, as required by SPEC section 7.3. */
const WEIGHT = { title: 40, heading: 14, description: 8, body: 3 };
/** A prefix hit is worth roughly half an exact word hit. */
const PREFIX_RATIO = 0.45;

/**
 * Turn a raw index document into the shape the scorer wants. Tolerant about field
 * names because the index is produced by a sibling module: `text`, `body` and
 * `content` are all accepted, headings may be objects or bare strings.
 * @param {unknown} raw
 * @returns {SearchEntry[]}
 */
function prepareIndex(raw) {
  // `build/search.js` emits the compact SPEC 7 shape -- `{ v, docs: [{ r, t, d, h, b }] }`
  // -- to keep the index small. Accept that, the verbose `{ pages: [...] }` form and a bare
  // array, so the runtime cannot silently disagree with the generator about field names.
  const rows = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.docs) ? raw.docs
      : (raw && Array.isArray(raw.pages) ? raw.pages : []));

  const pages = rows.map((row) => {
    if (!row || typeof row !== 'object') return null;
    if (row.route !== undefined || row.title !== undefined) return row;
    return {
      route: row.r,
      title: row.t,
      description: row.d,
      headings: Array.isArray(row.h)
        ? row.h.map((h) => (typeof h === 'string' ? h : { id: h && h.i, text: h && h.t }))
        : [],
      text: row.b,
    };
  });

  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!page || typeof page !== 'object') continue;
    const headings = (Array.isArray(page.headings) ? page.headings : []).map((h) => (
      typeof h === 'string'
        ? { id: '', text: h }
        : { id: String((h && h.id) || ''), text: String((h && h.text) || '') }
    ));
    const title = String(page.title || page.route || '');
    const description = String(page.description || page.summary || '');
    const body = String(page.text != null ? page.text : (page.body != null ? page.body : (page.content || '')));
    const headingText = headings.map((h) => h.text).join(' \n');
    const titleList = tokenize(title);
    const headingList = tokenize(headingText);
    const bodyList = tokenize(`${description} ${body}`, MAX_BODY_TOKENS);
    out.push({
      route: normalizeRoute(page.route || '/'),
      title,
      description,
      headings,
      body,
      titleSet: new Set(titleList),
      titleList: Array.from(new Set(titleList)),
      headingSet: new Set(headingList),
      headingList: Array.from(new Set(headingList)),
      bodySet: new Set(bodyList),
      bodyList: Array.from(new Set(bodyList)),
    });
  }
  return out;
}

/**
 * @param {Set<string>} set
 * @param {string[]} list
 * @param {string} token
 * @returns {number} 1 for an exact word, PREFIX_RATIO for a prefix, 0 for no hit
 */
function fieldHit(set, list, token) {
  if (set.has(token)) return 1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].length > token.length && list[i].indexOf(token) === 0) return PREFIX_RATIO;
  }
  return 0;
}

/**
 * Score one page against the tokenised query. Returns 0 when any query token matches
 * nothing at all -- searches are AND, not OR, or a two-word query returns the whole site.
 * @param {SearchEntry} entry
 * @param {string[]} tokens
 * @param {string} phrase full lowercase query, for phrase bonuses
 * @returns {number}
 */
function scoreEntry(entry, tokens, phrase) {
  let score = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const inTitle = fieldHit(entry.titleSet, entry.titleList, token);
    const inHeading = fieldHit(entry.headingSet, entry.headingList, token);
    const inBody = fieldHit(entry.bodySet, entry.bodyList, token);
    if (!inTitle && !inHeading && !inBody) return 0;
    score += inTitle * WEIGHT.title
      + inHeading * WEIGHT.heading
      + inBody * WEIGHT.body;
  }
  const lowerTitle = entry.title.toLowerCase();
  if (phrase) {
    if (lowerTitle === phrase) score += 120;
    else if (lowerTitle.indexOf(phrase) === 0) score += 60;
    else if (lowerTitle.indexOf(phrase) > 0) score += 25;
    if (entry.description.toLowerCase().indexOf(phrase) >= 0) score += WEIGHT.description;
  }
  // Shallow pages are usually the landing pages people mean.
  score += Math.max(0, 6 - entry.route.split('/').filter(Boolean).length);
  return score;
}

/**
 * Locate a readable window of body text around the first query hit and return the
 * slice plus the ranges to mark. Pure string work so it stays testable.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {{ text: string, ranges: Array<[number, number]>, leading: boolean, trailing: boolean }}
 */
function snippetFor(text, tokens) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = source.toLowerCase();
  let at = -1;
  let hit = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const found = lower.indexOf(tokens[i]);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
      hit = tokens[i];
    }
  }
  if (at < 0) {
    return {
      text: source.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER),
      ranges: [],
      leading: false,
      trailing: source.length > SNIPPET_BEFORE + SNIPPET_AFTER,
    };
  }
  let start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(source.length, at + hit.length + SNIPPET_AFTER);
  // Prefer a word boundary so the snippet does not begin mid-word.
  if (start > 0) {
    const space = source.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  const window = source.slice(start, end);
  const windowLower = window.toLowerCase();

  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    let cursor = 0;
    let guard = 0;
    while (cursor < windowLower.length && guard < 200) {
      guard += 1;
      const found = windowLower.indexOf(token, cursor);
      if (found < 0) break;
      ranges.push([found, found + token.length]);
      cursor = found + token.length; // always advances: token.length >= 1
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);

  /** @type {Array<[number, number]>} */
  const merged = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1];
    if (last && ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push([ranges[i][0], ranges[i][1]]);
  }

  return {
    text: window,
    ranges: merged,
    leading: start > 0,
    trailing: end < source.length,
  };
}

/**
 * Render a snippet into a fragment. Index content is untrusted author text, so every
 * character goes through `createTextNode` -- `innerHTML` is never used here.
 * @param {{ text: string, ranges: Array<[number, number]>, leading: boolean, trailing: boolean }} snippet
 * @returns {DocumentFragment}
 */
function renderSnippet(snippet) {
  const fragment = document.createDocumentFragment();
  if (snippet.leading) fragment.appendChild(document.createTextNode('…'));
  let cursor = 0;
  for (let i = 0; i < snippet.ranges.length; i += 1) {
    const [from, to] = snippet.ranges[i];
    if (from > cursor) {
      fragment.appendChild(document.createTextNode(snippet.text.slice(cursor, from)));
    }
    const mark = document.createElement('mark');
    mark.textContent = snippet.text.slice(from, to);
    fragment.appendChild(mark);
    cursor = to;
  }
  if (cursor < snippet.text.length) {
    fragment.appendChild(document.createTextNode(snippet.text.slice(cursor)));
  }
  if (snippet.trailing) fragment.appendChild(document.createTextNode('…'));
  return fragment;
}

let searchOpen = false;
/** @type {SearchEntry[]|null} */
let searchIndex = null;
/** @type {Promise<SearchEntry[]>|null} */
let searchLoading = null;
/** @type {(() => void)|null} */
let releaseSearchFocus = null;
/** @type {Element|null} */
let searchReturnFocus = null;

/** @returns {string[]} candidate URLs for the index, best guess first */
function searchIndexUrls() {
  const declared = (document.body && document.body.getAttribute('data-search'))
    || document.documentElement.getAttribute('data-search-index');
  const urls = [];
  if (declared) {
    try {
      urls.push(new URL(declared, site.href).href);
    } catch (err) { /* ignore a malformed hint */ }
  }
  urls.push(`${site.href}search-index.json`);
  urls.push(`${site.href}assets/search-index.json`);
  return urls.filter((url, i) => urls.indexOf(url) === i);
}

/**
 * Fetch and prepare the index exactly once.
 * @returns {Promise<SearchEntry[]>}
 */
function loadSearchIndex() {
  if (searchIndex) return Promise.resolve(searchIndex);
  if (searchLoading) return searchLoading;
  const urls = searchIndexUrls();
  const attempt = (i) => {
    if (i >= urls.length) return Promise.reject(new Error('search index not found'));
    return fetch(urls[i], { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch(() => attempt(i + 1));
  };
  searchLoading = attempt(0).then((raw) => {
    searchIndex = prepareIndex(raw);
    return searchIndex;
  });
  return searchLoading;
}

/**
 * @param {string} query
 * @returns {Array<{ entry: SearchEntry, score: number }>}
 */
function runSearch(query) {
  if (!searchIndex) return [];
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const phrase = query.trim().toLowerCase();
  const hits = [];
  for (let i = 0; i < searchIndex.length; i += 1) {
    const score = scoreEntry(searchIndex[i], tokens, phrase);
    if (score > 0) hits.push({ entry: searchIndex[i], score });
  }
  hits.sort((a, b) => (b.score - a.score) || a.entry.title.localeCompare(b.entry.title));
  return hits.slice(0, MAX_RESULTS);
}

/**
 * Build the modal when layout.js did not emit one. Search is a JS-only feature, so
 * creating its DOM at runtime costs the no-JS experience nothing.
 * @returns {{ modal: Element, input: HTMLInputElement, results: Element }|null}
 */
function ensureSearchModal() {
  let modal = $('.search-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'search-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Search documentation');
    modal.innerHTML = '<div class="search-modal__panel">'
      + '<input class="search-input" type="search" autocomplete="off" spellcheck="false"'
      + ' placeholder="Search documentation" aria-label="Search documentation">'
      + '<div class="search-results" role="listbox" aria-label="Search results"></div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  const input = $('.search-input', modal);
  const results = $('.search-results', modal);
  if (!input || !results) return null;
  return { modal, input, results };
}

function initSearch() {
  const parts = ensureSearchModal();
  if (!parts) return;
  const { modal, input, results } = parts;
  const overlay = ensureOverlay();
  const trigger = $('.search-trigger');
  let activeIndex = -1;
  let pending = 0;

  const resultItems = () => $$('.search-result', results);

  const setActive = (index) => {
    const items = resultItems();
    if (!items.length) {
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    activeIndex = Math.max(0, Math.min(items.length - 1, index));
    for (let i = 0; i < items.length; i += 1) {
      const on = i === activeIndex;
      items[i].classList.toggle('is-active', on);
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        items[i].id = items[i].id || `md2spa-result-${i}`;
        input.setAttribute('aria-activedescendant', items[i].id);
        if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const renderMessage = (message) => {
    results.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'search-results__empty';
    empty.textContent = message;
    results.appendChild(empty);
    activeIndex = -1;
  };

  const render = (query) => {
    const tokens = tokenize(query);
    if (!tokens.length) {
      results.textContent = '';
      activeIndex = -1;
      return;
    }
    const hits = runSearch(query);
    if (!hits.length) {
      renderMessage(`No results for “${query}”`);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < hits.length; i += 1) {
      const entry = hits[i].entry;
      const link = document.createElement('a');
      link.className = 'search-result';
      link.href = hrefForRoute(entry.route);
      link.setAttribute('role', 'option');
      link.setAttribute('aria-selected', 'false');
      link.id = `md2spa-result-${i}`;

      const title = document.createElement('span');
      title.className = 'search-result__title';
      title.textContent = entry.title;
      link.appendChild(title);

      const route = document.createElement('span');
      route.className = 'search-result__route';
      route.textContent = entry.route;
      link.appendChild(route);

      const context = entry.body || entry.description;
      if (context) {
        const snippet = document.createElement('span');
        snippet.className = 'search-result__snippet';
        snippet.appendChild(renderSnippet(snippetFor(context, tokens)));
        link.appendChild(snippet);
      }
      fragment.appendChild(link);
    }
    results.textContent = '';
    results.appendChild(fragment);
    setActive(0);
  };

  const close = () => {
    if (!searchOpen) return;
    searchOpen = false;
    modal.hidden = true;
    if (!drawerOpen) overlay.hidden = true;
    document.documentElement.removeAttribute('data-search-open');
    document.body.classList.remove('search-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    unlockScroll();
    if (releaseSearchFocus) {
      releaseSearchFocus();
      releaseSearchFocus = null;
    }
    if (searchReturnFocus && searchReturnFocus.focus) searchReturnFocus.focus();
    searchReturnFocus = null;
  };

  const open = () => {
    if (searchOpen) return;
    if (drawer && drawerOpen) drawer.close();
    searchOpen = true;
    searchReturnFocus = document.activeElement;
    modal.hidden = false;
    overlay.hidden = false;
    document.documentElement.setAttribute('data-search-open', 'true');
    document.body.classList.add('search-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    lockScroll();
    releaseSearchFocus = trapFocus(modal);
    input.focus();
    input.select();

    const token = pending + 1;
    pending = token;
    if (!searchIndex) renderMessage('Loading search index…');
    loadSearchIndex().then(() => {
      if (pending !== token || !searchOpen) return;
      render(input.value);
    }, () => {
      if (pending !== token || !searchOpen) return;
      renderMessage('Search is unavailable on this page');
    });
  };

  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      open();
    });
  }

  input.addEventListener('input', () => {
    if (!searchIndex) return;
    render(input.value);
  });

  input.addEventListener('keydown', (event) => {
    const items = resultItems();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (event.key === 'Home' && items.length) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && items.length) {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === 'Enter') {
      const chosen = items[activeIndex];
      if (chosen) {
        event.preventDefault();
        const href = chosen.href;
        close();
        go(href);
      }
    }
  });

  results.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('.search-result')) close();
  });

  overlay.addEventListener('click', () => {
    if (searchOpen) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchOpen) {
      event.preventDefault();
      close();
      return;
    }
    if (event.defaultPrevented || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      open();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    // `/` is a shortcut everywhere except inside a field the user is typing into.
    const target = event.target;
    const typing = !!(target && target.closest
      && (target.closest('input, textarea, select') || target.closest('[contenteditable]')));
    if (event.key === '/' && !typing) {
      event.preventDefault();
      open();
    }
  });
}

/* ------------------------------------------------------------------ router */

/** route -> payload. Bounded; insertion order gives us a free LRU-ish eviction. */
const payloadCache = new Map();
/** @type {AbortController|null} */
let inflight = null;
/** @type {number} */
let progressTimer = 0;
/** Monotonic history key; scroll offsets are stored against it. */
let historyKey = 0;
/** @type {Map<number, number>} */
const scrollPositions = new Map();

/**
 * @param {string} route
 * @param {object} payload
 */
function cachePayload(route, payload) {
  if (payloadCache.size >= CACHE_LIMIT) {
    const oldest = payloadCache.keys().next();
    if (!oldest.done) payloadCache.delete(oldest.value);
  }
  payloadCache.set(route, payload);
}

function showProgress() {
  const bar = $('.progress-bar');
  if (!bar) return;
  bar.hidden = false;
  bar.classList.add('is-active');
  bar.setAttribute('aria-hidden', 'true');
}

function hideProgress() {
  const bar = $('.progress-bar');
  if (!bar) return;
  bar.classList.remove('is-active');
  bar.hidden = true;
}

/**
 * @param {string} route
 * @param {AbortSignal} signal
 * @returns {Promise<object>}
 */
function fetchPayload(route, signal) {
  const cached = payloadCache.get(route);
  if (cached) return Promise.resolve(cached);
  // `new URL` percent-encodes non-ASCII route segments the way the server stored them.
  const url = new URL(payloadPathFor(route), site.href).href;
  return fetch(url, { signal, credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.json();
    })
    .then((payload) => {
      if (!payload || typeof payload !== 'object' || typeof payload.html !== 'string') {
        throw new Error('malformed SPA payload');
      }
      cachePayload(route, payload);
      return payload;
    });
}

/**
 * The document title is `Page — Site`; payloads only carry `Page`. Recover the suffix
 * once from the server-rendered title so the router can rebuild it for every route.
 * @returns {string}
 */
function deriveTitleSuffix() {
  const declared = document.documentElement.getAttribute('data-title-suffix');
  if (declared !== null) return declared;
  const heading = $('article.md h1');
  const pageTitle = heading ? (heading.textContent || '').replace(/#$/, '').trim() : '';
  const full = document.title || '';
  if (pageTitle && full.indexOf(pageTitle) === 0) return full.slice(pageTitle.length);
  return '';
}

let titleSuffix = '';

/**
 * @param {Array<{ id: string, text: string, depth: number, children?: any[] }>} items
 * @returns {HTMLOListElement}
 */
function buildTocList(items) {
  const list = document.createElement('ol');
  list.className = 'toc__list';
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const li = document.createElement('li');
    li.className = 'toc__item';
    if (item.depth) li.setAttribute('data-depth', String(item.depth));
    const link = document.createElement('a');
    link.className = 'toc__link';
    link.href = `#${encodeURIComponent(String(item.id || ''))}`;
    link.textContent = String(item.text || '');
    li.appendChild(link);
    if (Array.isArray(item.children) && item.children.length) {
      li.appendChild(buildTocList(item.children));
    }
    list.appendChild(li);
  }
  return list;
}

/**
 * @param {Array<{ id: string, text: string, depth: number, children?: any[] }>} toc
 */
function updateToc(toc) {
  const aside = $('.toc');
  if (!aside) return;
  const items = Array.isArray(toc) ? toc : [];
  const existing = $('.toc__list', aside);
  if (!items.length) {
    if (existing) existing.remove();
    aside.hidden = true;
    return;
  }
  aside.hidden = false;
  const list = buildTocList(items);
  if (existing) existing.replaceWith(list);
  else aside.appendChild(list);
}

/**
 * Mirror `layout.js`: the payload carries ancestors only, and the current page is appended
 * as a non-link `aria-current` item.
 *
 * @param {Array<{ title: string, route: string }>} crumbs ancestors, root first
 * @param {string} [currentTitle]
 */
function updateCrumbs(crumbs, currentTitle) {
  let nav = $('.breadcrumbs');
  const items = Array.isArray(crumbs) ? crumbs.slice() : [];
  if (!nav) {
    // The home page renders no trail, so the container does not exist yet. Navigating away
    // from it still needs one.
    if (!items.length) return;
    const main = $('.content');
    if (!main) return;
    nav = document.createElement('nav');
    nav.className = 'breadcrumbs';
    nav.setAttribute('aria-label', 'Breadcrumb');
    main.insertBefore(nav, main.firstChild);
  }
  let list = $('.breadcrumbs__list', nav);
  if (!items.length) {
    if (list) list.textContent = '';
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  if (!list) {
    list = document.createElement('ol');
    list.className = 'breadcrumbs__list';
    nav.appendChild(list);
  }
  list.textContent = '';
  for (let i = 0; i < items.length; i += 1) {
    const crumb = items[i] || {};
    const li = document.createElement('li');
    li.className = 'breadcrumbs__item';
    if (crumb.route) {
      const link = document.createElement('a');
      link.className = 'breadcrumbs__link';
      link.href = hrefForRoute(crumb.route);
      link.textContent = String(crumb.title || '');
      li.appendChild(link);
    } else {
      li.textContent = String(crumb.title || '');
    }
    list.appendChild(li);
  }

  const current = String(currentTitle == null ? '' : currentTitle).trim();
  if (current) {
    const li = document.createElement('li');
    li.className = 'breadcrumbs__item';
    li.setAttribute('aria-current', 'page');
    li.textContent = current;
    list.appendChild(li);
  }
}

/**
 * Update an existing prev/next anchor in place where possible so layout.js keeps
 * ownership of the internal markup.
 * @param {string} selector
 * @param {{ title: string, route: string }|null} data
 * @param {string} label
 */
function updatePageNavLink(selector, data, label) {
  const nav = $('.page-nav');
  if (!nav) return;
  let link = $(selector, nav);
  if (!data || !data.route) {
    if (link) link.hidden = true;
    return;
  }
  if (!link) {
    link = document.createElement('a');
    link.className = selector.replace('.', '');
    const kind = document.createElement('span');
    kind.className = 'page-nav__label';
    kind.textContent = label;
    const title = document.createElement('span');
    title.className = 'page-nav__title';
    link.appendChild(kind);
    link.appendChild(title);
    nav.appendChild(link);
  }
  link.hidden = false;
  link.href = hrefForRoute(data.route);
  const title = $('.page-nav__title', link);
  if (title) title.textContent = String(data.title || '');
  else link.textContent = String(data.title || '');
}

/**
 * @param {string|null} editUrl
 */
function updateEditLink(editUrl) {
  const link = $('.edit-link');
  if (!link) return;
  if (!editUrl) {
    link.hidden = true;
    return;
  }
  link.hidden = false;
  link.setAttribute('href', editUrl);
}

/**
 * Replace the article body. Payloads may carry the `<article>` wrapper (SPEC section 7)
 * or just its children; both are handled.
 * @param {Element} article
 * @param {string} html
 */
function swapArticle(article, html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const only = holder.children.length === 1 ? holder.firstElementChild : null;
  if (only && only.tagName === 'ARTICLE') {
    article.className = only.className || 'md';
    article.innerHTML = only.innerHTML;
    return;
  }
  article.innerHTML = html;
}

/**
 * @param {object} payload
 * @param {string} route
 * @param {string} hash
 */
function applyPayload(payload, route, hash) {
  const article = $('article.md');
  if (!article) throw new Error('no article to swap');

  swapArticle(article, payload.html);

  document.title = payload.title ? payload.title + titleSuffix : document.title;
  const meta = $('meta[name="description"]');
  if (meta) meta.setAttribute('content', String(payload.description || ''));
  document.body.setAttribute('data-route', route);

  updateToc(payload.toc);
  updateCrumbs(payload.crumbs, payload.title);
  updatePageNavLink('.page-nav__prev', payload.prev, 'Previous');
  updatePageNavLink('.page-nav__next', payload.next, 'Next');
  updateEditLink(payload.editUrl);

  runAfterSwap();

  const heading = $('h1', article) || article;
  heading.setAttribute('tabindex', '-1');
  try {
    heading.focus({ preventScroll: true });
  } catch (err) {
    heading.focus();
  }

  const target = hash ? document.getElementById(decodeHash(hash)) : null;
  if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
  else window.scrollTo(0, 0);

  announce(String(payload.title || route));
}

/**
 * @param {string} hash
 * @returns {string}
 */
function decodeHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return raw;
  }
}

/** Remember where the user was before leaving the current history entry. */
function saveScroll() {
  scrollPositions.set(historyKey, window.scrollY || window.pageYOffset || 0);
}

/**
 * Navigate. Every failure path ends in `location.assign`, which is simply the
 * navigation the browser would have performed had this file never loaded.
 *
 * @param {string} href absolute URL to navigate to
 * @param {{ push?: boolean, restore?: number|null }} [options]
 */
function navigate(href, options) {
  const opts = options || {};
  let url;
  try {
    url = new URL(href, location.href);
  } catch (err) {
    location.assign(href);
    return;
  }
  const route = routeFromUrl(url);
  if (route === null) {
    location.assign(href);
    return;
  }

  if (opts.push !== false) saveScroll();
  if (inflight) inflight.abort();
  const controller = new AbortController();
  inflight = controller;

  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(showProgress, PROGRESS_DELAY);

  fetchPayload(route, controller.signal).then((payload) => {
    if (controller !== inflight) return; // superseded by a later click
    clearTimeout(progressTimer);
    progressTimer = 0;
    hideProgress();
    inflight = null;

    if (opts.push !== false) {
      historyKey += 1;
      history.pushState({ md2spa: true, key: historyKey }, '', url.href);
    }
    applyPayload(payload, route, url.hash);

    if (opts.restore != null) {
      const top = scrollPositions.get(opts.restore) || 0;
      window.scrollTo(0, top);
    }
  }, (err) => {
    if (err && err.name === 'AbortError') return;
    clearTimeout(progressTimer);
    progressTimer = 0;
    hideProgress();
    inflight = null;
    location.assign(url.href);
  });
}

/**
 * Navigate via the router when it is running, otherwise perform a plain browser
 * navigation. Used by search results.
 * @param {string} href
 */
function go(href) {
  if (routerEnabled) navigate(href, { push: true });
  else location.assign(href);
}

let routerEnabled = false;

/**
 * Decide whether a click should be handled in-page.
 * @param {MouseEvent} event
 * @param {HTMLAnchorElement} link
 * @returns {boolean}
 */
function isRoutableClick(event, link) {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (link.hasAttribute('download')) return false;
  if (link.hasAttribute('data-no-spa')) return false;
  const target = link.getAttribute('target');
  if (target && target !== '_self') return false;
  const rel = (link.getAttribute('rel') || '').toLowerCase();
  if (rel.split(/\s+/).indexOf('external') >= 0) return false;
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return false;
  if (link.origin !== location.origin) return false;
  const raw = link.getAttribute('href') || '';
  if (raw.charAt(0) === '#') return false;
  // Same document, different fragment: let the browser do its native anchor jump.
  if (link.pathname === location.pathname && link.search === location.search && link.hash) {
    return false;
  }
  return true;
}

function initRouter() {
  // file:// has no fetch-able payloads and no useful origin; the pre-rendered site is
  // already perfect there, so simply do not start.
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') return;
  if (!$('article.md')) return;

  routerEnabled = true;
  titleSuffix = deriveTitleSuffix();
  // We restore scroll ourselves, keyed by history entry; the browser's own guess is
  // wrong once the article is swapped rather than reloaded.
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch (err) {
    /* not fatal -- the browser keeps its default behaviour */
  }
  history.replaceState({ md2spa: true, key: historyKey }, '', location.href);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const link = target.closest('a[href]');
    if (!link || !isRoutableClick(event, link)) return;
    if (routeFromUrl(new URL(link.href)) === null) return;
    event.preventDefault();
    navigate(link.href, { push: true });
  });

  window.addEventListener('popstate', (event) => {
    if (!routerEnabled) return;
    const state = event.state;
    const key = state && typeof state.key === 'number' ? state.key : 0;
    saveScroll();
    historyKey = key;

    // Popping between two anchors of the same page needs no refetch and no swap --
    // re-rendering the article would throw away the scroll position we are restoring.
    const route = routeFromUrl(new URL(location.href));
    if (route !== null && route === document.body.getAttribute('data-route')) {
      const heading = location.hash ? document.getElementById(decodeHash(location.hash)) : null;
      if (heading) heading.scrollIntoView({ behavior: 'auto', block: 'start' });
      else window.scrollTo(0, scrollPositions.get(key) || 0);
      return;
    }

    navigate(location.href, { push: false, restore: key });
  });

  // Keep the current entry's offset fresh so a same-page back/forward lands correctly.
  window.addEventListener('beforeunload', saveScroll);
}

/* ------------------------------------------------------------------ boot */

function main() {
  site = resolveSite();
  safely('live region', initLiveRegion);
  safely('url normalisation', absolutizeShell);
  safely('nav index', buildNavIndex);
  safely('theme toggle', initTheme);
  safely('code copy', initCodeCopy);
  safely('scrollspy', initScrollspy);
  safely('sidebar', initSidebar);
  safely('drawer', initDrawer);
  safely('search', initSearch);
  safely('router', initRouter);
}

function boot() {
  safely('runtime', main);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

/**
 * Pure helpers exposed for `node --test`. Not part of the browser API surface --
 * nothing in this module reads them, and no other module should import them.
 */
export const internals = {
  normalizeRoute,
  payloadPathFor,
  tokenize,
  prepareIndex,
  scoreEntry,
  snippetFor,
  fieldHit,
};
