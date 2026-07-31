---
title: Deploying
description: Publish the built site to GitLab Pages, GitHub Pages or any static host, without changing a line of config.
---

# Deploying

`md2spa build` writes a directory of static files. Any host that can serve a directory
can serve it: object storage, a CDN, `nginx`, a Raspberry Pi, a USB stick.

## The only two decisions

**Where does the output go?** `--out public` for GitLab Pages, `--out dist` (the default)
for most others. Set it once in CI.

**Where will the site live?** Leave `base` at `"auto"` and the answer stops mattering:
every URL in the output is document-relative, so the same build works at `/`, at
`/user/project/`, and in a subfolder of a larger site. For opening the folder directly
over `file://`, also set `cleanUrls: false` -- see [Other hosts](other-hosts.md).

That is the whole configuration. [Base paths](advanced/base-paths.md) explains what `auto`
does and the two cases where you would override it.

## Start here

```bash
md2spa template            # list the targets
md2spa template gitlab     # write a working pipeline
```

[Deployment templates](templates.md) covers all three — GitLab, GitHub and a self-hosted
Docker image — and what to do after running the command.

## Per-host guides

- [GitLab Pages](gitlab-pages.md) — the bundled `.gitlab-ci.yml`, which works unmodified.
- [GitHub Pages](github-pages.md) — the Actions workflow and the `.nojekyll` gotcha.
- [Other hosts](other-hosts.md) — Netlify, Vercel, Cloudflare Pages, nginx, Caddy, Docker.
- [CI recipes](advanced/ci-recipes.md) — lint gates, previews and cache settings.

## What the build writes

| Path | Contents |
|:---|:---|
| `index.html` and one per route | Fully pre-rendered pages. Work with JavaScript disabled |
| `_spa/*.json` | One payload per route, fetched by the router. Omitted with `--no-spa` |
| `assets/style.<hash>.css` | The whole stylesheet. Content-hashed |
| `assets/app.<hash>.js` | The SPA runtime. Content-hashed |
| `search-index.json` | Fetched once, lazily, when search is first opened |
| `sitemap.xml`, `robots.txt` | Emitted when `siteUrl` is set |
| `404.html` | Served for unknown paths. Finds its own assets from any depth |
| everything in `static/` | Copied verbatim |

Nothing needs a server runtime, a rewrite rule or a redirect map. The SPA router uses
`history.pushState` over URLs that already exist as files, so a hard reload on any route
serves the real pre-rendered page.

## Cache headers

Hashed assets are safe to cache forever; HTML and payloads are not.

| Pattern | Suggested header |
|:---|:---|
| `assets/*.css`, `assets/*.js` | `Cache-Control: public, max-age=31536000, immutable` |
| `*.html` | `Cache-Control: public, max-age=0, must-revalidate` |
| `_spa/*.json` | `Cache-Control: public, max-age=0, must-revalidate` |
| `search-index.json` | `Cache-Control: public, max-age=300` |

If your host does not let you set headers per pattern, do nothing. The filenames are
content-hashed, so a stale HTML page still resolves to the correct assets.

## The pre-flight check

Run this before the first deploy, and in CI afterwards:

```bash
npx md2spa check --strict
npx md2spa build --out public
```

`check --strict` fails on every broken link, every missing anchor and every malformed
table. Fixing them before the deploy is considerably cheaper than after.

## Deployment artifacts in this repository

Three targets are scaffolded by `md2spa template <target>`, which copies from
`templates/` into the right paths for you:

| Target | Files written |
|:---|:---|
| `gitlab` | `.gitlab-ci.yml` |
| `github` | `.github/workflows/pages.yml`, `static/.nojekyll` |
| `server` | `Dockerfile`, `nginx.conf`, `docker-compose.yml`, `.dockerignore` |

Hosts that need a configuration file rather than a pipeline are documented instead, with
copy-paste snippets in [Other hosts](other-hosts.md): Netlify, Vercel, Cloudflare Pages,
Caddy, S3 and CloudFront.

Every one of them assumes `base: "auto"`, which is why none of them contains a hard-coded
site path.
