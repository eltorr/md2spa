---
title: Installation
description: Run md2spa with npx, install it into a project, or vendor the source directly.
order: 1
---

# Installation

md2spa is a single package with an empty `dependencies` block. Installing it downloads
one tarball and creates no transitive tree.

## Requirements

- Node.js 18.0.0 or newer. The tool uses only `node:fs`, `node:path`, `node:url`,
  `node:http`, `node:crypto` and `node:test`.
- Nothing else. No Python, no Ruby, no native build step, no headless browser.

Check your version:

```bash
node --version
```

## Option 1: npx, no install

Best for CI and for trying the tool out.

```bash
npx md2spa build
npx md2spa dev
```

`npx` caches the package for the session. In CI this is one network round trip; because
there are no dependencies there is nothing to resolve.

## Option 2: a project dev dependency

Best for a repository whose docs are built by more than one person.

```bash
npm install --save-dev md2spa
```

Then wire it into `package.json`:

```json
{
  "scripts": {
    "docs:dev": "md2spa dev",
    "docs:build": "md2spa build --out public",
    "docs:check": "md2spa check --strict"
  }
}
```

`npm run docs:build` resolves `md2spa` from `node_modules/.bin`, so the version is
pinned by your lockfile.

## Option 3: vendor the source

Best for air-gapped builds and for projects that refuse to add any dependency at all.

```bash
git clone https://gitlab.com/md2spa/md2spa.git vendor/md2spa
node vendor/md2spa/src/cli.js build
```

The CLI entry point is `src/cli.js` and it has no build step. What is in the repository is
what runs.

## Verify the installation

```bash
npx md2spa --version
npx md2spa --help
```

`--version` prints the version and exits `0`. `--help` prints the command summary. Any
other exit status means the install is broken. Exit codes are listed under
[CLI exit codes](../reference/cli.md#exit-codes).

> [!TIP]
> If `md2spa` is not on your `PATH` after a global install, call it through the package
> manager instead of adding directories to `PATH`. `npx md2spa` and
> `npm exec md2spa` both work without any shell configuration.

## Upgrading

md2spa follows semantic versioning. Because there are no dependencies, an upgrade cannot
break anything except md2spa itself. The two things to check after a major bump:

- New rule codes may fire on existing content. Silence individual rules with the `rules`
  block described in [Configuration](configuration.md#tuning-rule-severity).
- The generated class names in [the HTML contract](../writing/advanced/custom-html.md)
  are stable within a major version. Custom CSS that targets them may need review.

## Uninstalling

Delete the package. The generated `dist/` directory is plain HTML, CSS and JavaScript
with no references to the tool, so a site that has already been built keeps working
forever.
