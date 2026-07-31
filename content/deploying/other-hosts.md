---
title: Other hosts
description: Netlify, Vercel, Cloudflare Pages, nginx, Caddy, Docker, object storage, and serving from a local file.
order: 3
---

# Other hosts

The build output is a directory of files with no server requirements. Everything below is
the same site, published differently.

## Netlify

```
[build]
  command = "npx md2spa build --out dist"
  publish = "dist"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
```

The redirect rule is optional. Without it Netlify serves its own 404 page instead of the
themed one.

## Vercel

```json
{
  "buildCommand": "npx md2spa build --out dist",
  "outputDirectory": "dist",
  "cleanUrls": false,
  "trailingSlash": true
}
```

Set `cleanUrls: false` in `vercel.json` — that is Vercel's own URL rewriting, and md2spa
has already produced the directory layout it would otherwise try to create. `trailingSlash: true`
matches the routes the build emits.

## Cloudflare Pages

Build command `npx md2spa build --out dist`, output directory `dist`. Add a `_redirects`
file to `static/` if you want the themed 404:

```
/*  /404.html  404
```

Cloudflare Pages sets long cache lifetimes on hashed assets automatically.

## nginx

```
server {
  listen 80;
  root /srv/docs;
  index index.html;

  location / {
    try_files $uri $uri/ $uri/index.html /404.html;
  }

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  error_page 404 /404.html;
}
```

The `try_files` chain is what makes `cleanUrls` work: a request for `/guide/install/`
falls through to `/guide/install/index.html`.

## Caddy

```
docs.example.com {
  root * /srv/docs
  file_server
  try_files {path} {path}/ {path}/index.html /404.html
  handle_errors {
    rewrite * /404.html
    file_server
  }
  header /assets/* Cache-Control "public, max-age=31536000, immutable"
}
```

Caddy provisions a certificate automatically, which makes it the shortest path from a
built directory to an HTTPS site.

## Docker

`md2spa template server` writes a complete setup — a two-stage `Dockerfile`, an
`nginx.conf` with the 404 fallback and cache split already configured, a
`docker-compose.yml`, and a `.dockerignore`:

```bash
md2spa template server
docker compose up --build -d      # http://localhost:8080
```

The build stage runs `node:20-alpine` and needs no `npm install`, so the image builds
offline. The final image contains static files and nginx and nothing else.

See [Deployment templates](templates.md#self-hosted-with-docker) for what each file does.

## Object storage

S3, R2, Backblaze, MinIO and friends all work. Two settings matter:

- **Index document**: `index.html`. Without it, `/guide/` returns a listing or a 403.
- **Error document**: `404.html`.

```bash
aws s3 sync dist/ s3://my-docs-bucket/ --delete \
  --cache-control "public, max-age=0, must-revalidate"
aws s3 sync dist/assets/ s3://my-docs-bucket/assets/ \
  --cache-control "public, max-age=31536000, immutable"
```

Sync the whole tree first with short cache headers, then re-sync the hashed assets with
long ones.

## Inside a larger site

Copy `dist/` into a subdirectory of an existing site — `/help/`, `/docs/v2/` — and it
works, because every URL in the output is relative to the document that contains it. No
rebuild, no `base` setting, no rewrite rules.

This is also how you keep several versions online at once: `/docs/v1/`, `/docs/v2/`,
`/docs/latest/`, each one an unmodified build.

## From a file, with no server at all

```bash
npx md2spa build
open dist/index.html
```

`cleanUrls: false` is the part that matters here. With clean URLs a link to a section
reads `getting-started/`, and a browser opening a `file://` directory will not resolve
that to `index.html` the way a web server does. Turning clean URLs off makes every link
name a real file -- `getting-started/index.html`, `getting-started/installation.html` --
so navigation works with no server at all.

Search and the SPA router stay disabled under `file://`, because browsers block `fetch`
on that scheme. The pre-rendered pages, the sidebar and every link remain fully
functional; only the instant-navigation upgrade is missing.

This is what you send to someone who needs the documentation on a machine with no network.
Zip `dist/` and it is a complete, self-contained manual.

## A note on redirects

md2spa does not emit redirect pages. When a route moves, fix the internal links —
`MD044` lists every one of them — and add a redirect at the hosting layer for external
bookmarks:

| Host | Mechanism |
|:---|:---|
| Netlify, Cloudflare Pages | a `_redirects` file in `static/` |
| Vercel | a `redirects` array in `vercel.json` |
| nginx | `return 301` in a `location` block |
| Caddy | a `redir` directive |
| GitLab Pages | a `_redirects` file in the published directory |
| GitHub Pages | none; keep a stub page at the old route |
