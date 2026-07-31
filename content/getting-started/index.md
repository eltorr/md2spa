---
title: Getting started
description: Install md2spa, learn the folder layout, and configure a site in about ten minutes.
---

# Getting started

This section takes you from an empty directory to a published site. It is short on
purpose: md2spa has one config file, four commands, and no plugin system.

## Read in this order

1. [Installation](installation.md) — the three supported ways to run the tool.
2. [Project structure](project-structure.md) — how folders become routes and sidebar entries.
3. [Configuration](configuration.md) — the keys you are most likely to set.

Once the site builds, [Writing content](../writing/index.md) covers the Markdown dialect
and [Deploying](../deploying/index.md) covers publishing.

## The shortest possible site

A single file is a valid site.

```bash
mkdir -p docs/content
printf -- '---\ntitle: Hello\n---\n\n# Hello\n' > docs/content/index.md
cd docs && npx md2spa build
```

`dist/` now contains `index.html`, the stylesheet, the SPA runtime, a search index, a
sitemap and a `404.html`. There is no config file yet; every key has a default.

## What the build actually does

1. Load `md2spa.config.json` if it exists, otherwise use defaults.
2. Walk `contentDir`, skipping drafts and names beginning with `_`.
3. Parse each file into an AST, collecting diagnostics as it goes.
4. Build the navigation tree, breadcrumbs and prev/next chain from the folder layout.
5. Resolve every relative link and asset reference against the page set.
6. Render HTML, the SPA JSON payload and the search index for each route.
7. Copy `staticDir` verbatim, write `sitemap.xml`, `robots.txt` and `404.html`.
8. Verify the emitted HTML and print the diagnostic summary.

Steps 3, 5 and 8 are where the linter lives. If any of them produces an error the build
exits with status `1` and writes nothing further. See
[Diagnostics](../reference/diagnostics.md) for the rule catalogue.

## Requirements at a glance

| Requirement | Value |
|---|---|
| Node.js | 18.0.0 or newer |
| npm packages | none |
| Network access at build time | none |
| Output | static files, no server runtime |
