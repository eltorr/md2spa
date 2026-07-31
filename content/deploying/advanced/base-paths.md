---
title: Base paths
description: How base auto emits document-relative URLs, when to override it, and why 404.html needs special handling.
order: 1
---

# Base paths

"It works locally but every stylesheet 404s on the server" is the oldest bug in static
site generation. It happens because the generator wrote `/assets/style.css` and the site
is served from `/user/project/`.

md2spa's default answer is not to write absolute paths at all.

## The three modes

| `base` | URLs look like | Works at |
|:---|:---|:---|
| `"auto"` (default) | `../../assets/style.a1b2c3d4.css` | any path, any host (add `cleanUrls: false` for `file://`) |
| `"/"` | `/assets/style.a1b2c3d4.css` | the domain root only |
| `"/prefix/"` | `/prefix/assets/style.a1b2c3d4.css` | exactly that prefix |

Every URL the build emits — stylesheets, scripts, images, internal links, the logo, the
canonical tag — goes through a single helper that applies the chosen mode. There is no
second code path that can disagree with the first.

## How `auto` works

A page knows how deep it is. `/writing/advanced/base-paths/` is three directories below
the root, so every URL on that page is prefixed with `../../../`. The depth is also
written onto the document as `data-depth`:

```html
<html lang="en" data-depth="3" data-theme-default="auto">
```

The client-side router needs an absolute base to fetch payloads, and derives it from that
attribute at load time:

```js
const depth = Number(document.documentElement.dataset.depth || 0);
const siteBase = new URL('../'.repeat(depth) || './', location.href).pathname;
```

Because the base comes from the document's own URL, the site cannot be wrong about where
it is. Move the directory, rename the repository, mount it under a different prefix —
the arithmetic still holds.

With an explicit `base`, the document carries `data-base="/prefix/"` instead and the
runtime trusts that value directly.

## When to override it

Two cases, both narrow.

**You need absolute URLs in the HTML.** Some link checkers, some CMS embeds and some proxy
setups rewrite relative URLs and get them wrong. Set `base` to `"/"` or to the real
prefix.

**The site is served through a rewriting proxy.** If a request for `/docs/guide/` is
rewritten to `/guide/` before the file server sees it, the document's own URL no longer
reflects its depth. Set `base` to the externally visible prefix.

```bash
md2spa build --base /docs/
```

Otherwise, leave it. `"auto"` has no downside: relative URLs are the same length, cache
the same way, and are correct in more situations.

## What `auto` does not affect

`siteUrl` is still absolute, because canonical links, `sitemap.xml` and Open Graph tags
must be. `base` controls the URLs *inside* the document; `siteUrl` declares where the
document lives on the public internet. They are independent, and setting one does not
imply the other.

If `siteUrl` is empty, those three outputs are simply omitted. Nothing else changes.

## The `404.html` problem

Every other page knows its depth because it knows its own route. `404.html` does not: a
host serves it for `/typo`, for `/a/b/c/typo`, and for anything else that misses. A
relative asset path that is correct at one depth is wrong at the others.

md2spa solves it by embedding the route list in the 404 page along with a small inline
script. The script takes `location.pathname`, finds the longest known route that is a
suffix of it, and infers the site base from what is left over. If nothing matches it falls
back to `base`, or to `/`.

```
Request:  /handbook/guide/nope/
Routes:   /, /guide/, /guide/install/
Match:    /guide/ is not a suffix; / is
Base:     /handbook/guide/nope/ minus / -> /handbook/
```

The script is inline, tiny, and contains no `eval`. If it fails, the 404 page still
renders with unstyled text and a working link home — the failure mode of a page that is
already a failure mode.

## Multiple versions on one domain

Because a build carries no absolute paths, several builds can live side by side:

```
/docs/v1/      built from the v1 tag
/docs/v2/      built from the v2 tag
/docs/latest/  a copy of v2
```

Each directory is an unmodified `dist/`. No `--base` flag, no per-version config, no
rebuild when `latest` moves. Copy the directory and you are done.

## Verifying it

The quickest check is to serve the output from a subdirectory:

```bash
npx md2spa build --out /tmp/site/sub/dir
cd /tmp/site && python3 -m http.server 8000
```

Then open `http://localhost:8000/sub/dir/`. If the stylesheet, the logo, the sidebar links
and a deep page reload all work there, they will work anywhere.

The bundled CI configurations in [GitLab Pages](../gitlab-pages.md) and
[GitHub Pages](../github-pages.md) both rely on this, which is why neither of them
mentions a base path.
