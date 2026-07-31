---
title: GitHub Pages
description: A GitHub Actions workflow that builds and deploys the site, and the two Pages behaviours that catch people out.
order: 2
---

# GitHub Pages

GitHub Pages publishes an uploaded artifact. The workflow below builds the site and hands
it over; nothing else is needed.

## The workflow

Save this as `.github/workflows/pages.yml`.

```yaml
name: Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx md2spa check --strict
      - run: npx md2spa build --out dist
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

There is no `npm ci` step and no dependency cache, because there are no dependencies.
`actions/setup-node` is there for a known Node version, not for a package manager.

The lint step runs before the build, so a broken link fails the workflow before anything
is published.

## Two things that catch people out

### Jekyll processes the artifact unless you stop it

GitHub Pages runs Jekyll over uploaded content by default, and Jekyll ignores any file or
directory whose name begins with an underscore. md2spa writes its SPA payloads to
`_spa/`, so on a Jekyll-processed deployment every client-side navigation returns a 404
while the pre-rendered pages work fine — a genuinely confusing failure.

The fix is a `.nojekyll` file at the root of the artifact. Put an empty one in `static/`
and it is copied on every build:

```bash
touch static/.nojekyll
git add -f static/.nojekyll
```

`actions/upload-pages-artifact` does not run Jekyll, so the modern workflow above is
already safe. Add the file anyway: it costs nothing and it protects you if the deployment
method ever changes.

### Project sites live under a subpath

A repository site is served from `https://<user>.github.io/<repo>/`, not from the domain
root. Generators normally handle this with a `basePath` setting that has to match the
repository name, and that breaks the moment the repository is renamed or forked.

md2spa emits document-relative URLs, so there is nothing to set. The same `dist/` works
at the user-site root and under a project subpath. See [Base paths](advanced/base-paths.md).

## Deploying from a branch instead

If your repository publishes from a `gh-pages` branch rather than an artifact, build into
the branch and add `.nojekyll` explicitly:

```yaml
      - run: npx md2spa build --out dist
      - run: touch dist/.nojekyll
```

Then push `dist/` to `gh-pages` with whichever action you already use. The `.nojekyll`
file is required here — branch deployments do run Jekyll.

## Custom domains

Add a `CNAME` file containing the domain to `static/`, so it is copied into the output on
every build:

```bash
echo docs.example.com > static/CNAME
```

Set `siteUrl` to the same domain so canonical links and the sitemap agree with it.

## Troubleshooting

| Symptom | Cause | Fix |
|:---|:---|:---|
| Pages load, in-page navigation 404s | Jekyll stripped `_spa/` | Add `.nojekyll` to `static/` |
| Everything 404s | The artifact path is wrong | `upload-pages-artifact` `path:` must match `--out` |
| Deploy step fails on permissions | Missing token scopes | Include `pages: write` and `id-token: write` |
| Assets 404 under `/repo/` | `base` was hard-coded to `"/"` | Set it back to `"auto"` |
| Custom domain reverts after a deploy | `CNAME` is not in the artifact | Keep it in `static/`, not only in the branch |
