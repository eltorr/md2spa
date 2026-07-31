# Deploying md2spa

Every recipe in this folder is copy-pasteable and works with the **default configuration**.
The reason is `base: "auto"`: md2spa emits document-relative URLs (`../../assets/style.1a2b3c4d.css`)
computed from each page's route depth, so one build artifact is valid at a domain root, under a
`/project/` path prefix, inside a subfolder of a larger site, and over `file://`.

## The matrix

| Host | Build command | Output dir | `base` | Fallback mechanism | Gotchas |
|---|---|---|---|---|---|
| **GitLab Pages** | `node src/cli.js build --out public` | `public` | `auto` | GitLab serves `404.html` | The output dir *must* be `public`. Restrict the `pages` job to `$CI_DEFAULT_BRANCH`. |
| **GitHub Pages** | `node src/cli.js build --out dist` | `dist` | `auto` | GitHub serves `404.html` | Set Pages source to "GitHub Actions". Needs `pages: write` + `id-token: write`. |
| **Netlify** | `node src/cli.js build` | `dist` | `auto` | `[[redirects]]` to `/404.html` (status 404) | Put the catch-all redirect last; Netlify stops at the first match. |
| **Vercel** | `node src/cli.js build` | `dist` | `auto` | Vercel serves `404.html` from the output root | Keep `trailingSlash: true` in step with `cleanUrls: true` in md2spa. |
| **nginx / Docker** | `node src/cli.js build --out /site` | image `/usr/share/nginx/html` | `auto` | `try_files $uri $uri/ /404.html` | Run `md2spa template server` to scaffold the Dockerfile and nginx config. |
| **Caddy** | `node src/cli.js build` | `dist` mounted at `/srv/site` | `auto` | `handle_errors` -> `/404.html` | `file_server` already handles directory indexes and trailing-slash redirects. |
| **S3 / CloudFront** | `node src/cli.js build` | `dist` | `auto` | Error document `404.html` | Set the index document to `index.html`; CloudFront needs a custom error response mapping 404 -> `/404.html`. |
| **Any web server, any subfolder** | `node src/cli.js build` | `dist` | `auto` | whatever that server does | Nothing to configure. Copy `dist/` anywhere and it works. |
| **Offline / `file://` / a zip** | `node src/cli.js build` | `dist` | `auto` | none needed | Requires `cleanUrls: false` so links point at real `.html` files. |

## Scaffolded recipes

GitLab, GitHub Pages and a self-hosted Docker image are written for you, into the paths
they belong in:

```bash
md2spa template            # list the targets
md2spa template gitlab     # or: github, server
```

## Files in this folder

These hosts take a configuration file rather than a pipeline, so they are kept here to
copy by hand.


| File | Copy to | Purpose |
|---|---|---|
| `netlify.toml` | repo root, same name | build, redirects, cache headers |
| `_redirects` | `static/_redirects` (copied verbatim into `outDir`) | SPA/404 fallback for Netlify or Cloudflare Pages when you are not using `netlify.toml` |
| `vercel.json` | repo root, same name | build, clean URLs, cache headers |
| `Caddyfile` | `/etc/caddy/Caddyfile` | same policy, automatic HTTPS |

## When to set `base` explicitly

Keep `auto` unless one of these applies.

| Situation | Setting |
|---|---|
| You need root-relative URLs (a proxy rewrites paths, or a CDN worker inlines HTML) | `"base": "/"` |
| The site is permanently mounted at a known prefix and you want absolute paths | `"base": "/docs/"` |
| Anything else, including GitLab/GitHub project pages | `"base": "auto"` |

`base` affects only the URLs written into pages. Absolute URLs for `sitemap.xml`, canonical
links and Open Graph tags come from **`siteUrl`**, which cannot be derived at build time —
set it (`"siteUrl": "https://user.gitlab.io/project"`) whenever you care about SEO or sharing.

## Caching policy, in one line

Files under `assets/` carry an 8-hex content hash in the filename, so they are `immutable`
for a year. Everything else — page HTML, `_spa/*.json` route payloads, `search-index.json`,
`sitemap.xml` — is rewritten in place on every build and must revalidate, or the SPA router
will swap in a stale page body after a deploy. Every recipe here encodes exactly that split.

## Linting in CI

`md2spa check` exits `1` when there are errors (add `--strict` to fail on warnings too),
so it works as a gate with no extra wiring. Pick the format that matches the host:

| CI | Flag | Result |
|---|---|---|
| GitLab | `--format junit > report.xml` | test report in the merge-request widget (`artifacts: reports: junit`) |
| GitHub Actions | `--format github` | inline annotations on the pull-request diff |
| Anything else | `--format json` | machine-readable; `--format pretty` (default) for humans |
