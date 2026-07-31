---
title: Deployment templates
description: One command adds a working CI pipeline or a Docker image. What each template contains and what to do after running it.
order: 1
---

# Deployment templates

Three ready-made recipes ship with md2spa. Each is one command, and each produces files
you own and can edit — there is no hidden layer generating configuration at build time.

```bash
md2spa template            # list the targets
md2spa template gitlab     # write the files for one
```

| Target | Writes | Publishes to |
|:---|:---|:---|
| `gitlab` | `.gitlab-ci.yml` | `https://<namespace>.gitlab.io/<project>/` |
| `github` | `.github/workflows/pages.yml`, `static/.nojekyll` | `https://<user>.github.io/<repo>/` |
| `server` | `Dockerfile`, `nginx.conf`, `docker-compose.yml`, `.dockerignore` | Wherever you run the container |

Existing files are never overwritten. Run with `--force` when you want to replace one.

## The repository layout these assume

The templates assume your repository **is** a copy of md2spa: the tool in `src/`, your
Markdown in `content/`.

```
my-docs/
├── .gitlab-ci.yml         <- md2spa template gitlab
├── md2spa.config.json
├── src/                   <- md2spa itself, committed
├── content/               <- your pages
│   └── index.md
└── static/                <- assets copied verbatim
```

That is why every CI job here is a single `node src/cli.js …` line with **no install step**.
md2spa has no runtime dependencies, so there is no `npm ci`, no lockfile, no registry and
no network access in the pipeline. A build cannot fail because a transitive dependency was
yanked or a registry was down, and it runs in about the time it takes to check out the repo.

The trade is that upgrading md2spa means pulling from upstream rather than bumping a
version number. For documentation — where the generator changes far less often than the
content — that is usually the better side of the deal.

!!! note "Starting from scratch"
    Fork or clone md2spa, delete the bundled `content/` pages, then run
    `md2spa init` for a fresh skeleton and `md2spa template <target>` for CI.

## GitLab

```bash
md2spa template gitlab
git add .gitlab-ci.yml
git commit -m "Add GitLab Pages pipeline"
git push
```

That is the whole process. On the next push to your default branch the pipeline runs two
jobs and the site is live.

| Job | Runs on | Does |
|:---|:---|:---|
| `lint` | Every branch and MR | `md2spa check --format junit` — failures appear in the merge-request widget |
| `pages` | Default branch only | `md2spa build --out public` — GitLab publishes the artifact |

Two details are load-bearing. **The output directory must be `public`** — that is the
directory name GitLab Pages looks for, which is why the job overrides the default `dist`.
And **no `base` setting is needed** despite the `/<project>/` path prefix, because
`base: "auto"` emits document-relative URLs. See [Base paths](advanced/base-paths.md) for
why that works.

The JUnit report is worth the two extra lines. Instead of scrolling a job log to find
which link broke, the failure shows up on the merge request with the file, the line and
the fix hint.

!!! tip "Set `siteUrl` once"
    Nothing needs it to build, but `siteUrl` in `md2spa.config.json` is what makes
    canonical links, Open Graph tags and `sitemap.xml` absolute. For GitLab Pages that is
    `https://<namespace>.gitlab.io/<project>`.

## GitHub

```bash
md2spa template github
git add .github static/.nojekyll
git commit -m "Add GitHub Pages workflow"
git push
```

Then, once: **Settings → Pages → Build and deployment → Source → "GitHub Actions"**. Until
that is set, the workflow runs and the deploy step has nothing to publish to.

The workflow lints on pull requests using `--format github`, so a broken link is annotated
inline on the diff rather than buried in a log. Only the default branch deploys.

The template also drops an empty `static/.nojekyll`. Jekyll silently deletes any directory
whose name starts with an underscore, and md2spa emits its SPA payloads into `_spa/` —
without that marker, pre-rendered pages would load fine while every client-side navigation
404'd. The Actions-based deployment does not run Jekyll, so this is insurance that starts
mattering the moment anyone switches Pages back to "Deploy from a branch".

## Self-hosted with Docker

```bash
md2spa template server
docker compose up --build -d      # http://localhost:8080
```

A two-stage build: `node:20-alpine` builds the site, `nginx:alpine` serves it. The runtime
image holds static files and nginx and nothing else — no Node.js, no source, no package
manager — so it is small and there is very little in it to keep patched.

| File | Purpose |
|:---|:---|
| `Dockerfile` | Two stages, plus a health check |
| `nginx.conf` | Clean URLs, 404 fallback, caching, compression, security headers |
| `docker-compose.yml` | Port mapping, restart policy, read-only root filesystem |
| `.dockerignore` | Keeps `dist/`, `.git/` and friends out of the build context |

The build runs with `--strict`, so a warning fails the image build rather than shipping.
Drop the flag in the `Dockerfile` if you would rather warnings not block a deploy.

Two things in `nginx.conf` matter more than the rest:

```nginx
try_files $uri $uri/ =404;
error_page 404 /404.html;
```

An unknown path serves md2spa's generated 404 page with a real 404 status, rather than
nginx's stock error page.

```nginx
location ~* "\.[0-9a-f]{8}\.(css|js)$" {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Asset filenames contain a content hash, so they can be cached forever. HTML and the
`_spa/*.json` payloads get `max-age=0, must-revalidate` instead. Getting that pair
backwards is the usual reason a deploy appears not to have taken effect.

Redeploying is a rebuild: the site is baked into the image, so the running container has
nothing writable and no build tooling in it.

## Other hosts

Netlify, Vercel, Caddy, S3 and CloudFront are covered in
[Other hosts](other-hosts.md) — they need configuration files rather than a pipeline, so
they are documented instead of scaffolded.

Any static host works without configuration, because the default build produces ordinary
directories of `index.html` files with relative URLs. If your host is not listed anywhere,
upload `dist/` and it will work.
