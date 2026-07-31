---
title: Custom HTML
description: The three-way raw HTML policy, the tag and attribute allowlists, and the URL schemes that survive sanitisation.
order: 1
---

# Custom HTML

Raw HTML is md2spa's only extension point. There is no plugin system, so when Markdown
runs out of syntax the answer is a `<dl>`, a `<details>` or a `<span class="badge">`.

Everything you write is sanitised on the way out. The rules below are the whole policy.

## The three-way policy

Technical prose is full of angle brackets that are not HTML: `<your-volume>`, `<num>`,
`<key>`, XML snippets quoted mid-sentence. A sanitiser that warns about all of them
produces so much noise that people stop reading the output. So md2spa sorts every tag it
sees into one of three buckets.

| The tag is | What happens | Diagnostic |
|:---|:---|:---|
| On the allowlist | Passed through, attributes filtered | none |
| A real HTML element that is not allowed | Escaped to visible text | `MD052` warning |
| Not a known HTML element | Escaped to visible text | none |

The third row is the important one. `<your-volume>` renders as the literal text
&lt;your-volume&gt; with no complaint, because that is obviously what the author meant.
`<iframe>` renders as literal text *and* is reported, because that is obviously not.

## Allowed tags

```
a abbr b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl
dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s
samp small source span strong sub summary sup table tbody td tfoot th thead time tr u ul
var wbr
```

Everything a documentation page needs, and nothing that can load or run code.

Explicitly not allowed, and reported when seen: `script`, `style`, `iframe`, `object`,
`embed`, `form`, `input`, `button`, `select`, `textarea`, `link`, `meta`, `base`, `svg`,
`math`, `template`, `noscript`, `audio`, `video`, `canvas`, `dialog`.

`svg` is on that list even though it is harmless in most documents, because inline SVG can
carry event handlers and `<foreignObject>`. Reference an SVG file from `static/` with an
`<img>` instead — that is how the logo on this site is drawn.

## Attributes

These are allowed on any element: `class`, `id`, `title`, `lang`, `dir`, `role`,
`translate`, plus every `aria-*` and `data-*` attribute.

These are allowed on specific elements:

| Element | Extra attributes |
|:---|:---|
| `a` | `href`, `target`, `rel`, `download`, `hreflang`, `type`, `name` |
| `img` | `src`, `alt`, `width`, `height`, `loading`, `decoding`, `srcset`, `sizes`, `referrerpolicy` |
| `source` | `src`, `srcset`, `sizes`, `type`, `media`, `width`, `height` |
| `td` | `colspan`, `rowspan`, `headers`, `abbr` |
| `th` | `colspan`, `rowspan`, `headers`, `scope`, `abbr` |
| `col`, `colgroup` | `span` |
| `ol` | `start`, `type`, `reversed` |
| `li` | `value` |
| `details` | `open`, `name` |
| `time` | `datetime` |
| `q`, `blockquote` | `cite` |
| `del`, `ins` | `cite`, `datetime` |
| `bdo` | `dir` |
| `pre` | `tabindex` |

Two attributes are always removed, with an `MD052` each:

- Anything starting with `on` — `onclick`, `onerror`, `onload`. Inline event handlers
  never reach the output, which is what lets the site run under a strict
  Content-Security-Policy.
- `style`. Add a class and put the rule in your stylesheet.

## URLs

Attributes that carry a URL — `href`, `src`, `srcset`, `cite` — are checked against a
scheme allowlist before they are emitted.

Allowed: `http`, `https`, `mailto`, `tel`, `sms`, `irc`, `ircs`, `ftp`, `ftps`, `matrix`,
`xmpp`, `magnet`, `news`, `feed`, `git`, `ssh`, `steam`, `geo`, `bitcoin`, `callto`,
`webcal`. Relative paths, fragments and query-only URLs are always allowed.

`data:` URLs are allowed for raster images only — `png`, `gif`, `jpeg`, `webp`, `avif`,
`bmp` and `ico`. `data:image/svg+xml` is refused, because an SVG data URL is a script
delivery mechanism.

Everything else, `javascript:` above all, is dropped and reported. Control characters are
stripped before the check, so the classic bypass below does not work:

```html
<a href="java&#9;script:alert(1)">not a link</a>
<img src="x" onerror="alert(1)">
<script>alert(1)</script>
```

All three of those lines are escaped to visible text in the output, and each one produces
an `MD052`.

## Worked examples

### Definition lists

Markdown has no definition list. HTML does.

<dl>
<dt><code>base: "auto"</code></dt>
<dd>Emit document-relative URLs. The site works at any path, on any host.</dd>
<dt><code>base: "/"</code></dt>
<dd>Emit root-relative URLs with no prefix.</dd>
<dt><code>base: "/prefix/"</code></dt>
<dd>Emit root-relative URLs under a fixed prefix.</dd>
</dl>

```html
<dl>
<dt><code>base: "auto"</code></dt>
<dd>Emit document-relative URLs.</dd>
</dl>
```

### Disclosure widgets

`<details>` and `<summary>` are real browser features, so they work with JavaScript
disabled and their content is found by in-page search.

<details>
<summary>What the build writes into <code>dist/</code></summary>
<p>One HTML file per route, one JSON payload per route under <code>_spa/</code>, a hashed
stylesheet and script under <code>assets/</code>, a search index, <code>sitemap.xml</code>,
<code>robots.txt</code> and <code>404.html</code>, plus everything in <code>static/</code>
copied verbatim.</p>
</details>

If all you need is a collapsible callout, the `???` admonition syntax is shorter and comes
with a title bar. See [Admonitions](../admonitions.md).

### Figures with captions

```html
<figure>
  <img src="../../../diagram.png" alt="The CLI calls the builder, which calls the parser">
  <figcaption>Build pipeline. Every arrow is a plain function call.</figcaption>
</figure>
```

`figure`, `figcaption`, `picture` and `source` are all allowed, so responsive images and
captioned diagrams work without any Markdown extension.

### Inline touches

Keyboard keys — press <kbd>Ctrl</kbd> + <kbd>K</kbd> — abbreviations like
<abbr title="Content Security Policy">CSP</abbr>, machine-readable dates such as
<time datetime="2024-01-15">15 January 2024</time>, <mark>highlighted spans</mark>,
super and subscripts (I<sup>2</sup>C, H<sub>2</sub>O), and status pills:
<span class="badge badge--ok">Stable</span> <span class="badge badge--wip">Beta</span>.

## Diagnostics

| Code | Severity | Fires when |
|:---|:---|:---|
| `MD051` | warning | An allowed tag is opened and never closed, or closed without being opened |
| `MD052` | warning | A disallowed tag, attribute or URL scheme was removed |

`MD051` is not fatal: the sanitiser closes anything you leave dangling so the emitted
document stays well-formed, and then tells you where it had to intervene. The final
`verifyHtml` pass double-checks the whole document and raises `HTM001` if anything is
still unbalanced.

## What is silently dropped

Comments, `<!DOCTYPE>` declarations, CDATA sections and XML processing instructions are
removed entirely, with no diagnostic. They have no meaning inside an article body, and a
comment is the one place authors reasonably expect nothing to happen.

Since HTML comments do not survive, use frontmatter or a `draft: true` page for notes to
yourself. A commented-out paragraph is not preserved in the output — which is the correct
behaviour, but it surprises people once.
