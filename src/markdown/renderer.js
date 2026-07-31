/**
 * AST -> HTML.
 *
 * The renderer owns three things nothing else may duplicate:
 *
 *   1. **The class contract.** Every element it emits is spelled out in SPEC 8b; the
 *      stylesheet targets those names and nothing else. Changing markup here is an API
 *      change.
 *   2. **Heading ids.** The parser leaves `heading.id === null` because de-duplication is
 *      a whole-document concern. The registry is injected so a caller can share one across
 *      a page that is rendered in pieces.
 *   3. **URL policy.** Every link and image destination goes through the injected
 *      `resolveUrl(url, node)` callback and then `sanitizeUrl()`. `.md` rewriting and
 *      base-path handling live in build/build.js; escaping and scheme filtering live here.
 *      Nothing else in the pipeline may write an `href` or `src` from Markdown.
 *
 * Everything is pure apart from one deliberate mutation: the resolved id is written back
 * onto the heading node so later passes (validate, cross-page anchor checks) see the same
 * value the HTML carries.
 *
 * @module markdown/renderer
 */

import {
  escapeHtml, escapeAttr, escapeHtmlPreservingEntities, sanitizeRawHtml, closeDanglingTags,
  sanitizeUrl, attrs,
} from '../util/html.js';
import { createBag } from './diagnostics.js';
import { createSlugRegistry, slugify } from './slug.js';
import { highlight, isKnownLanguage } from './highlight.js';
import { renderMermaid } from './mermaid/index.js';

/**
 * Recursion ceiling. A malformed document can nest blockquotes or lists thousands deep;
 * bail out rather than blow the stack.
 */
const MAX_DEPTH = 64;

/** Only these get `target="_blank"`; `mailto:`/`tel:`/`irc:` are links, not "elsewhere". */
const WEB_EXTERNAL = /^(?:https?:)?\/\//i;

/** A destination with a scheme we should leave completely alone. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Admonition kinds that map onto a distinct visual treatment (SPEC 8). */
/**
 * Admonition keyword -> emitted kind.
 *
 * Only keywords the stylesheet has no design for are folded into a neighbour. Everything
 * `style.css` styles distinctly (note, info, abstract, summary, tip, hint, success, check,
 * done, important, warning, caution, attention, danger, error, failure, bug, example,
 * quote, cite) passes through unchanged, so an author who writes `!!! bug` gets the bug
 * colour rather than a generic danger box. Anything absent from this map is emitted
 * verbatim and simply inherits the default admonition styling.
 */
const ADMONITION_ALIASES = {
  todo: 'info',
  question: 'note',
  faq: 'note',
  fail: 'failure',
  missing: 'failure',
};

// --- context -------------------------------------------------------------------------

/**
 * @typedef {Object} RenderContext
 * @property {string} file
 * @property {object} config
 * @property {ReturnType<typeof createBag>} bag
 * @property {ReturnType<typeof createSlugRegistry>} slugRegistry
 * @property {(url: string, node: object) => string} resolveUrl
 * @property {Array<{ url: string, resolved: string, external: boolean, line: number, column: number }>} links
 * @property {Array<{ url: string, resolved: string, alt: string, line: number, column: number }>} images
 * @property {Array<{ id: string, text: string, depth: number }>} headings
 * @property {{ order: string[], defs: Map<string, object>, slugs: Map<string, string>, refs: Map<string, number> }} footnotes
 */

/**
 * Build a full rendering context from user-supplied options.
 * @param {object} [options]
 * @returns {RenderContext}
 */
function createContext(options = {}) {
  const config = options.config || {};
  const resolveUrl = typeof options.resolveUrl === 'function' ? options.resolveUrl : null;
  return {
    __mdctx: true,
    file: options.file || '<input>',
    config,
    bag: options.bag || createBag(options.file || '<input>', { rules: config.rules || {} }),
    slugRegistry: options.slugRegistry || createSlugRegistry(),
    resolveUrl: resolveUrl || ((url) => url),
    links: [],
    images: [],
    headings: [],
    footnotes: { order: [], defs: new Map(), slugs: new Map(), refs: new Map() },
    // Diagrams drawn so far in this document. Marker ids are namespaced `d<N>-` off it, so
    // two diagrams on one page cannot collide on an id and the numbering is a pure function
    // of the source rather than of a module-level counter.
    diagramCount: 0,
    // Open-element stack shared by every raw-HTML node in the document: Markdown delivers
    // `<kbd>Ctrl</kbd>` as three separate nodes, so balance is a document-level property.
    htmlStack: [],
  };
}

// --- helpers -------------------------------------------------------------------------

/**
 * Location of a byte offset inside a multi-line node value, in document coordinates.
 * `sanitizeRawHtml` reports offsets into the fragment it was handed; diagnostics need
 * real line/column numbers.
 * @param {{ line?: number, column?: number }} node
 * @param {string} value
 * @param {number} offset
 * @returns {{ line: number, column: number, endLine: number, endColumn: number }}
 */
function locateOffset(node, value, offset) {
  const clamped = Math.max(0, Math.min(Number(offset) || 0, value.length));
  const before = value.slice(0, clamped);
  const lastBreak = before.lastIndexOf('\n');
  const breaks = lastBreak === -1 ? 0 : before.split('\n').length - 1;
  const baseLine = node?.line ?? 1;
  const baseColumn = node?.column ?? 1;
  const line = baseLine + breaks;
  const column = breaks === 0 ? baseColumn + before.length : clamped - lastBreak;
  return { line, column, endLine: line, endColumn: column + 1 };
}

/**
 * Pull a `<figcaption>` out of a fence's info string.
 * Accepts ```` ```js title="server.js" ```` and the bare-filename shorthand
 * ```` ```js server.js ```` that shows up constantly in real docs.
 * @param {string|null} meta
 * @returns {string|null}
 */
function extractCodeTitle(meta) {
  if (!meta) return null;
  const text = String(meta).trim().replace(/^\{|\}$/g, '').trim();
  if (!text) return null;

  const explicit = /(?:^|\s)(?:title|filename|file|caption)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
  if (explicit) {
    const value = explicit[1] ?? explicit[2] ?? explicit[3] ?? '';
    return value.trim() || null;
  }

  // A lone token that carries an extension reads as a filename; anything else is a
  // highlighter directive we do not implement, so it stays out of the caption.
  const first = text.split(/\s+/)[0];
  if (/^[\w@~.][\w./@+-]*\.[A-Za-z0-9]{1,12}$/.test(first)) return first;
  if (/^[\w./@+-]*\/[\w./@+-]+$/.test(first)) return first;
  return null;
}

/**
 * @param {string} kind
 * @returns {string} human title for an admonition with no explicit one
 */
function titleForKind(kind) {
  const clean = String(kind || 'note').replace(/[-_]+/g, ' ').trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Stable, unique anchor stem for a footnote identifier.
 * @param {string} identifier
 * @param {Set<string>} taken
 * @returns {string}
 */
function footnoteSlug(identifier, taken) {
  const base = slugify(String(identifier)) || 'note';
  let candidate = base;
  let n = 1;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  taken.add(candidate);
  return candidate;
}

// --- URL emission --------------------------------------------------------------------

/**
 * Run a destination through the caller's resolver and the scheme allowlist.
 * @param {string} raw
 * @param {object} node
 * @param {RenderContext} ctx
 * @returns {{ href: string, resolved: string }} `href` is `''` when the scheme was rejected
 */
function emitUrl(raw, node, ctx) {
  const original = String(raw ?? '').trim();
  let resolved = original;
  try {
    const out = ctx.resolveUrl(original, node);
    if (typeof out === 'string') resolved = out;
  } catch {
    // A resolver that throws must not take the build down; fall back to the authored URL.
    resolved = original;
  }
  return { href: sanitizeUrl(resolved), resolved };
}

// --- inline --------------------------------------------------------------------------

/**
 * Render a list of inline nodes.
 *
 * Exported so nav titles, breadcrumbs and search snippets reuse exactly the same
 * escaping and link policy. Pass the context from `renderHtml` to keep collecting
 * links/images, or omit it for a throwaway render.
 *
 * @param {object[]} nodes
 * @param {RenderContext|object} [ctx]
 * @returns {string}
 */
export function renderInline(nodes, ctx) {
  const context = ctx && ctx.__mdctx ? ctx : createContext(ctx || {});
  return inlines(nodes, context, 0);
}

/**
 * @param {object[]} nodes
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function inlines(nodes, ctx, depth) {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return '';
  let out = '';
  for (const node of nodes) out += inlineNode(node, ctx, depth);
  return out;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function inlineNode(node, ctx, depth) {
  if (!node || typeof node !== 'object') return '';

  switch (node.type) {
    case 'text':
      return escapeHtmlPreservingEntities(node.value ?? '');

    case 'strong':
      return `<strong>${inlines(node.children, ctx, depth + 1)}</strong>`;

    case 'emphasis':
      return `<em>${inlines(node.children, ctx, depth + 1)}</em>`;

    case 'delete':
      return `<del>${inlines(node.children, ctx, depth + 1)}</del>`;

    case 'inlineCode':
      // Code spans are literal: an authored `&amp;` must stay visible as `&amp;`.
      return `<code class="code-inline">${escapeHtml(node.value ?? '')}</code>`;

    case 'break':
      return '<br>';

    case 'link':
      return renderLink(node, ctx, depth);

    case 'image':
      return renderImage(node, ctx);

    case 'footnoteReference':
      return renderFootnoteRef(node, ctx);

    case 'html':
      return renderRawHtml(node, ctx);

    default:
      return node.children ? inlines(node.children, ctx, depth + 1) : '';
  }
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderLink(node, ctx, depth) {
  const label = inlines(node.children, ctx, depth + 1);
  const raw = String(node.url ?? '').trim();

  if (!raw) {
    ctx.bag.add('MD042', node, 'link has an empty destination',
      'Add a URL, or drop the brackets if it should be plain text.');
    return `<a class="link">${label}</a>`;
  }

  const { href, resolved } = emitUrl(raw, node, ctx);
  const external = WEB_EXTERNAL.test(resolved);
  ctx.links.push({
    url: raw, resolved, external, line: node.line ?? 1, column: node.column ?? 1,
  });

  if (!href) {
    ctx.bag.add('MD052', node, `unsafe link destination \`${raw}\` was removed`,
      'Only http(s), mailto, tel and raster data: URLs are emitted.');
    return label;
  }

  if (external) {
    const a = attrs({
      class: 'link link--external',
      href,
      title: node.title || null,
      rel: 'noopener noreferrer external',
      target: '_blank',
    });
    return `<a${a}>${label}<span class="link__icon" aria-hidden="true"></span></a>`;
  }

  return `<a${attrs({ class: 'link', href, title: node.title || null })}>${label}</a>`;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderImage(node, ctx) {
  const alt = String(node.alt ?? '');
  const raw = String(node.url ?? '').trim();

  if (!alt.trim()) {
    ctx.bag.add('MD043', node, 'image has no alt text',
      'Describe the image for screen readers, or use `![](…)` deliberately if it is decorative.');
  }

  if (!raw) {
    ctx.bag.add('MD042', node, 'image has an empty source', 'Add a path to the image file.');
    return escapeHtml(alt);
  }

  const { href, resolved } = emitUrl(raw, node, ctx);
  ctx.images.push({
    url: raw, resolved, alt, line: node.line ?? 1, column: node.column ?? 1,
  });

  if (!href) {
    ctx.bag.add('MD052', node, `unsafe image source \`${raw}\` was removed`,
      'Only http(s) and raster data: URLs are emitted.');
    return escapeHtml(alt);
  }

  return `<img${attrs({
    class: 'md-img',
    src: href,
    alt,
    title: node.title || null,
    loading: 'lazy',
    decoding: 'async',
  })}>`;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderFootnoteRef(node, ctx) {
  const key = String(node.identifier ?? '');
  const { order, slugs, refs } = ctx.footnotes;
  const index = order.indexOf(key);

  // An undefined reference is validate.js's finding (MD070); here it is just text.
  if (index === -1) return escapeHtml(`[^${key}]`);

  const stem = slugs.get(key);
  const seen = (refs.get(key) ?? 0) + 1;
  refs.set(key, seen);
  const refId = seen === 1 ? `fnref-${stem}` : `fnref-${stem}-${seen}`;

  return `<sup class="footnote-ref"><a${attrs({ id: refId, href: `#fn-${stem}` })}>${index + 1}</a></sup>`;
}

/**
 * Sanitise a raw HTML node and translate the sanitiser's offsets into diagnostics.
 * @param {object} node
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderRawHtml(node, ctx) {
  const value = String(node.value ?? '');
  const { html, issues } = sanitizeRawHtml(value, { stack: ctx.htmlStack });
  for (const issue of issues) {
    ctx.bag.add(issue.code, locateOffset(node, value, issue.offset), issue.message, issue.hint);
  }
  return html;
}

/**
 * Close every raw-HTML element the document left open and report each as `MD051`.
 * @param {RenderContext} ctx
 * @param {object[]} children top-level blocks, used only to locate the diagnostic
 * @returns {string}
 */
function closeOpenRawHtml(ctx, children) {
  if (!ctx.htmlStack.length) return '';
  const last = children[children.length - 1] || {};
  const { html, issues } = closeDanglingTags(ctx.htmlStack);
  for (const issue of issues) {
    ctx.bag.add(issue.code, { line: last.line || 1, column: last.column || 1 },
      issue.message, issue.hint);
  }
  return html;
}

// --- blocks --------------------------------------------------------------------------

/**
 * @param {object[]} nodes
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function blocks(nodes, ctx, depth) {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return '';
  let out = '';
  for (const node of nodes) out += blockNode(node, ctx, depth);
  return out;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function blockNode(node, ctx, depth) {
  if (!node || typeof node !== 'object') return '';

  switch (node.type) {
    case 'heading':
      return renderHeading(node, ctx, depth);

    case 'paragraph':
      return `<p>${inlines(node.children, ctx, depth + 1)}</p>`;

    case 'code':
      return renderCode(node, ctx);

    case 'list':
      return renderList(node, ctx, depth);

    case 'blockquote':
      return `<blockquote class="quote">${blocks(node.children, ctx, depth + 1)}</blockquote>`;

    case 'admonition':
      return renderAdmonition(node, ctx, depth);

    case 'table':
      return renderTable(node, ctx, depth);

    case 'thematicBreak':
      return '<hr>';

    case 'html':
      return renderRawHtml(node, ctx);

    // Pulled out of the flow and re-emitted at the end of the document.
    case 'footnoteDefinition':
    case 'definition':
      return '';

    default:
      return node.children ? blocks(node.children, ctx, depth + 1) : '';
  }
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderHeading(node, ctx, depth) {
  const level = Math.min(6, Math.max(1, Number(node.depth) || 1));
  const plain = String(node.text ?? '').trim();
  const { id, duplicate } = ctx.slugRegistry.next(plain);

  if (duplicate) {
    ctx.bag.add('MD014', node,
      `duplicate heading anchor, this one becomes \`#${id}\``,
      'Rename one of the headings so links stay stable when the page changes.');
  }

  // Later passes (anchor validation, TOC in the SPA payload) read the id off the node.
  node.id = id;
  ctx.headings.push({ id, text: plain, depth: level });

  const body = inlines(node.children, ctx, depth + 1);
  const anchor = `<a class="anchor" href="#${escapeAttr(id)}" aria-hidden="true" tabindex="-1">#</a>`;
  return `<h${level} id="${escapeAttr(id)}">${body}${anchor}</h${level}>`;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderCode(node, ctx) {
  const value = String(node.value ?? '');
  const lang = node.lang ? String(node.lang).trim() : '';
  const enabled = ctx.config.highlight !== false;

  if (MERMAID_LANGS.has(lang.toLowerCase()) && ctx.config.mermaid !== false) {
    const diagram = renderDiagram(node, value, ctx);
    if (diagram !== null) return diagram;
    // `null` means "could not draw it" -- the diagnostics are already in the bag and the
    // author's source falls through to the ordinary code-block path below, so the page is
    // still readable and still shows them what they wrote.
  }

  if (lang && enabled && !isKnownLanguage(lang)) {
    ctx.bag.add('MD022', node,
      `code fence language \`${lang}\` is not recognised`,
      'Use a supported language id, or `text` to render the block without highlighting.');
  }

  const { html } = enabled
    ? highlight(value, lang || null)
    : { html: escapeHtml(value) };

  // The tag reaches a class name and a CSS attribute selector, so keep it to characters
  // that cannot need escaping there -- the raw value still appears in the diagnostic.
  const tag = lang.toLowerCase().replace(/[^a-z0-9+#_.-]+/g, '') || null;
  const title = extractCodeTitle(node.meta);
  const caption = title
    ? `<figcaption class="code__title">${escapeHtml(title)}</figcaption>`
    : '';
  const codeAttrs = attrs({ class: tag ? `language-${tag}` : null });
  const figureAttrs = attrs({ class: 'code', 'data-lang': tag });

  return `<figure${figureAttrs}>${caption}<pre class="code__pre"><code${codeAttrs}>${html}</code></pre></figure>`;
}

/** Fence languages that mean "this is a diagram, draw it" (SPEC-MERMAID 9). */
const MERMAID_LANGS = new Set(['mermaid', 'mmd']);

/**
 * Draw one `mermaid` fence, or decide it cannot be drawn.
 *
 * The diagram counter advances for every *attempt*, not only for every success. Numbering by
 * attempt keeps a diagram's id namespace stable when an unrelated diagram earlier on the page
 * starts or stops rendering, which is what stops an edit to one figure from rewriting the ids
 * of every figure after it.
 *
 * @param {object} node the `code` node
 * @param {string} value the fence body, verbatim
 * @param {RenderContext} ctx
 * @returns {string|null} the `<figure class="diagram">`, or `null` to fall back to code
 */
function renderDiagram(node, value, ctx) {
  ctx.diagramCount += 1;
  const index = ctx.diagramCount;

  let result;
  try {
    result = renderMermaid(value, {
      file: ctx.file,
      // `node.line` is the opening fence; the body starts on the line after it, and that is
      // the line the diagram's own coordinates are relative to.
      line: (Number(node.line) || 1) + 1,
      column: Number(node.column) || 1,
      config: ctx.config,
      index,
    });
  } catch {
    // renderMermaid documents that it never throws. If that ever stops being true, a diagram
    // must still not be able to take down a build.
    return null;
  }

  if (Array.isArray(result?.diagnostics) && result.diagnostics.length) {
    ctx.bag.absorb(result.diagnostics);
  }
  if (typeof result?.svg !== 'string' || result.svg === '') return null;
  return markWideDiagram(result.svg);
}

/**
 * Intrinsic width past which a diagram scrolls rather than scaling down.
 *
 * The content column is ~46rem. `max-width: 100%` on its own silently scales a wide diagram
 * to fit it, and a 1291px flowchart squeezed into 688px draws its 13px labels at under 7px --
 * technically visible, actually unreadable. Legibility gives out around 0.85 scale, which is
 * where this threshold comes from; past it the figure scrolls instead, exactly as a wide
 * table already does.
 */
const WIDE_DIAGRAM_PX = 820;

/**
 * Flag a figure whose SVG is too wide to scale down legibly, so the stylesheet can let it
 * keep its intrinsic width and scroll inside the figure instead.
 *
 * @param {string} svg the complete `<figure class="diagram">…</figure>` fragment
 * @returns {string}
 */
function markWideDiagram(svg) {
  const width = Number((/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(svg) || [])[1]);
  if (!Number.isFinite(width) || width <= WIDE_DIAGRAM_PX) return svg;
  return svg.replace(/^(\s*<figure\b)/, '$1 data-wide="true"');
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderList(node, ctx, depth) {
  const items = Array.isArray(node.children) ? node.children : [];
  const isTask = items.some((item) => item && item.checked !== null && item.checked !== undefined);
  const tag = node.ordered ? 'ol' : 'ul';
  const start = node.ordered && Number.isFinite(node.start) && node.start !== 1 ? node.start : null;
  const open = attrs({ class: isTask ? 'task-list' : null, start });

  let out = `<${tag}${open}>`;
  for (const item of items) out += renderListItem(item, ctx, depth, node.tight !== false);
  return `${out}</${tag}>`;
}

/**
 * Tight items drop the `<p>` wrapper — that is what makes a tight list look tight, and
 * the stylesheet has no way to undo the extra block box.
 * @param {object} item
 * @param {RenderContext} ctx
 * @param {number} depth
 * @param {boolean} tight
 * @returns {string}
 */
function renderListItem(item, ctx, depth, tight) {
  if (!item || typeof item !== 'object') return '';
  const checked = item.checked;
  const isTask = checked !== null && checked !== undefined;

  let body = '';
  const children = Array.isArray(item.children) ? item.children : [];
  for (const child of children) {
    if (tight && child && child.type === 'paragraph') {
      body += inlines(child.children, ctx, depth + 1);
    } else {
      body += blockNode(child, ctx, depth + 1);
    }
  }

  const box = isTask
    ? `<input type="checkbox"${checked ? ' checked' : ''} disabled> `
    : '';
  return `<li${attrs({ class: isTask ? 'task-list__item' : null })}>${box}${body}</li>`;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderAdmonition(node, ctx, depth) {
  const rawKind = String(node.kind ?? 'note').toLowerCase().replace(/[^a-z0-9-]+/g, '');
  const kind = ADMONITION_ALIASES[rawKind] || rawKind || 'note';
  const title = node.title ? String(node.title) : titleForKind(rawKind);
  const body = blocks(node.children, ctx, depth + 1);

  if (node.collapsible) {
    const open = attrs({
      class: `admonition admonition--${kind} is-collapsible`,
      open: node.open === true,
    });
    return `<details${open}><summary class="admonition__title">${escapeHtml(title)}</summary>${body}</details>`;
  }

  return `<div class="admonition admonition--${escapeAttr(kind)}" role="note">`
    + `<p class="admonition__title">${escapeHtml(title)}</p>${body}</div>`;
}

/**
 * @param {object} node
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderTable(node, ctx, depth) {
  const align = Array.isArray(node.align) ? node.align : [];
  const cellClass = (index) => (align[index] ? `is-${align[index]}` : null);

  const header = Array.isArray(node.header) ? node.header : [];
  let head = '';
  if (header.length) {
    head = '<thead><tr>';
    for (let i = 0; i < header.length; i += 1) {
      head += `<th${attrs({ class: cellClass(i), scope: 'col' })}>`
        + `${inlines(header[i]?.children, ctx, depth + 1)}</th>`;
    }
    head += '</tr></thead>';
  }

  const rows = Array.isArray(node.rows) ? node.rows : [];
  let body = '';
  if (rows.length) {
    body = '<tbody>';
    for (const row of rows) {
      body += '<tr>';
      const cells = Array.isArray(row) ? row : [];
      for (let i = 0; i < cells.length; i += 1) {
        body += `<td${attrs({ class: cellClass(i) })}>`
          + `${inlines(cells[i]?.children, ctx, depth + 1)}</td>`;
      }
      body += '</tr>';
    }
    body += '</tbody>';
  }

  return `<div class="table-wrap"><table class="table">${head}${body}</table></div>`;
}

// --- footnotes -----------------------------------------------------------------------

/**
 * Index footnote definitions before the body renders, so a reference can print its
 * number even when the definition is 400 lines below it.
 * @param {object[]} children
 * @param {RenderContext} ctx
 */
function indexFootnotes(children, ctx) {
  const taken = new Set();
  for (const node of children) {
    if (!node || node.type !== 'footnoteDefinition') continue;
    const key = String(node.identifier ?? '');
    if (ctx.footnotes.defs.has(key)) continue; // duplicate: validate.js reports MD072
    ctx.footnotes.defs.set(key, node);
    ctx.footnotes.order.push(key);
    ctx.footnotes.slugs.set(key, footnoteSlug(key, taken));
  }
}

/**
 * Trailing `<section class="footnotes">`, definitions in source order, one back-link
 * per reference so a multiply-cited note can return to any of its call sites.
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderFootnotes(ctx, depth) {
  const { order, defs, slugs, refs } = ctx.footnotes;
  if (order.length === 0) return '';

  let items = '';
  for (const key of order) {
    const node = defs.get(key);
    const stem = slugs.get(key);
    const children = Array.isArray(node.children) ? node.children : [];

    const count = Math.max(1, refs.get(key) ?? 0);
    let back = '';
    for (let i = 1; i <= count; i += 1) {
      const target = i === 1 ? `fnref-${stem}` : `fnref-${stem}-${i}`;
      const label = count > 1 ? `<span class="footnote-back__n">${i}</span>` : '';
      back += ` <a class="footnote-back" href="#${escapeAttr(target)}" aria-label="Back to reference ${i}">&#8617;${label}</a>`;
    }

    // A one-paragraph note keeps the back-link on the same line, which is what every
    // other renderer does and what the SPEC 8b sample shows.
    let body;
    if (children.length === 1 && children[0].type === 'paragraph') {
      body = `<p>${inlines(children[0].children, ctx, depth + 1)}${back}</p>`;
    } else {
      body = blocks(children, ctx, depth + 1) + back;
    }

    items += `<li id="fn-${escapeAttr(stem)}">${body}</li>`;
  }

  return `<section class="footnotes"><h2 class="footnotes__title">Footnotes</h2><ol>${items}</ol></section>`;
}

// --- table of contents ---------------------------------------------------------------

/**
 * Nest a flat heading list into `{ id, text, depth, children }`.
 * Headings outside the configured range are skipped entirely rather than flattened, so
 * an h4 under a skipped h3 attaches to the nearest kept ancestor.
 * @param {Array<{ id: string, text: string, depth: number }>} headings
 * @param {number} minDepth
 * @param {number} maxDepth
 * @returns {Array<object>}
 */
function buildToc(headings, minDepth, maxDepth) {
  const root = { depth: minDepth - 1, children: [] };
  const stack = [root];

  for (const heading of headings) {
    if (heading.depth < minDepth || heading.depth > maxDepth) continue;
    const item = { id: heading.id, text: heading.text, depth: heading.depth, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= heading.depth) stack.pop();
    stack[stack.length - 1].children.push(item);
    stack.push(item);
  }

  return root.children;
}

// --- search text ---------------------------------------------------------------------

/**
 * Flatten a document to prose for the search index.
 *
 * Fenced and indented code bodies are excluded on purpose: in a technical corpus they
 * outweigh the prose several times over, and matching a token inside a shell transcript
 * is almost never what the reader meant. Inline code *is* included — that is where API
 * names live.
 *
 * @param {object[]} nodes
 * @param {string[]} out
 * @param {number} depth
 */
function collectText(nodes, out, depth) {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    switch (node.type) {
      case 'code':
      case 'html':
      case 'definition':
      case 'footnoteReference':
        break;
      case 'text':
      case 'inlineCode':
        out.push(String(node.value ?? ''));
        break;
      case 'image':
        if (node.alt) out.push(String(node.alt));
        break;
      case 'break':
        out.push(' ');
        break;
      case 'admonition':
        if (node.title) out.push(String(node.title));
        collectText(node.children, out, depth + 1);
        break;
      case 'table':
        for (const cell of node.header || []) collectText(cell?.children, out, depth + 1);
        for (const row of node.rows || []) {
          for (const cell of row || []) collectText(cell?.children, out, depth + 1);
        }
        break;
      default:
        collectText(node.children, out, depth + 1);
    }
  }
}

// --- entry point ---------------------------------------------------------------------

/**
 * Render a parsed document to the article body plus everything the build needs about it.
 *
 * @param {{ type: string, children: object[] }} ast document node from `parseMarkdown`
 * @param {Object} [options]
 * @param {string} [options.file] path used in diagnostics, POSIX, relative to cwd
 * @param {object} [options.config] normalised config (reads `toc`, `highlight`, `rules`)
 * @param {ReturnType<typeof createSlugRegistry>} [options.slugRegistry] shared id registry
 * @param {(url: string, node: object) => string} [options.resolveUrl]
 *   maps an authored destination to the URL that lands in the HTML; identity by default
 * @returns {{
 *   html: string,
 *   toc: Array<{ id: string, text: string, depth: number, children: Array<object> }>,
 *   headings: Array<{ id: string, text: string, depth: number }>,
 *   text: string,
 *   links: Array<{ url: string, resolved: string, external: boolean, line: number, column: number }>,
 *   images: Array<{ url: string, resolved: string, alt: string, line: number, column: number }>,
 *   diagnostics: import('./diagnostics.js').Diagnostic[]
 * }}
 */
export function renderHtml(ast, options = {}) {
  const ctx = createContext(options);
  const children = Array.isArray(ast?.children) ? ast.children : [];

  indexFootnotes(children, ctx);

  const body = blocks(children, ctx, 0) + closeOpenRawHtml(ctx, children);
  const footnotes = renderFootnotes(ctx, 0);

  const tocConfig = ctx.config.toc || {};
  const minDepth = Math.min(6, Math.max(1, Math.round(Number(tocConfig.minDepth ?? 2))));
  const maxDepth = Math.min(6, Math.max(minDepth, Math.round(Number(tocConfig.maxDepth ?? 3))));

  const textParts = [];
  collectText(children, textParts, 0);

  return {
    html: body + footnotes,
    toc: buildToc(ctx.headings, minDepth, maxDepth),
    headings: ctx.headings,
    text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
    links: ctx.links,
    images: ctx.images,
    diagnostics: ctx.bag.list(),
  };
}
