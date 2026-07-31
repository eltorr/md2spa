---
title: Configuration
description: Where the config file lives, the keys worth setting first, and how to tune rule severity.
order: 3
---

# Configuration

md2spa reads one config file from the working directory. Every key has a default, so the
file is optional; the shortest useful config is four lines.

## Where the file lives

The build probes these names in order and uses the first one it finds:

1. `md2spa.config.json`
2. `md2spa.config.js`
3. `md2spa.config.mjs`
4. `.md2sparc.json`

Pass `--config <path>` to use a different file. A missing config is not an error; a
config that exists but cannot be parsed is.

JSON files may contain `//` and `/* */` comments. They are stripped before parsing, so
you can annotate the file without switching to a JavaScript config.

## A minimal config

```json
{
  "title": "Acme Handbook",
  "description": "How we build and ship things.",
  "repo": { "url": "https://gitlab.com/acme/handbook", "label": "GitLab" }
}
```

That is enough for a real site. `contentDir`, `outDir`, `staticDir`, `base`, `cleanUrls`,
`spa`, `search` and `highlight` all default to sensible values.

## A JavaScript config

Use `md2spa.config.mjs` when a value has to be computed — a base path derived from an
environment variable, for instance.

```js
export default {
  title: 'Acme Handbook',
  base: process.env.CI_PAGES_URL ? 'auto' : '/',
  siteUrl: process.env.CI_PAGES_URL || '',
};
```

The module must have a default export that is a plain object. It is imported once, before
any content is read.

> [!WARNING]
> A JavaScript config runs with full Node privileges at build time. Treat it like any
> other build script: keep it in version control and review changes to it.

## Keys worth setting first

| Key | Default | Why you would change it |
|---|---|---|
| `title` | `"Documentation"` | Appears in the top bar, `<title>` and search results. |
| `description` | `""` | Default meta description for pages that do not set one. |
| `base` | `"auto"` | Leave it. See [Base paths](../deploying/advanced/base-paths.md). |
| `siteUrl` | `""` | Required for canonical URLs, `sitemap.xml` and Open Graph tags. |
| `outDir` | `"dist"` | GitLab Pages wants `public`; some hosts want `_site`. |
| `cleanUrls` | `true` | Set `false` when the host cannot serve directory indexes. |
| `theme.accent` | `"#5b5bd6"` | The single colour the whole design derives from. |
| `repo.editBase` | `""` | Enables the "Edit this page" link under every article. |

Every key is documented in the [Configuration reference](../reference/config-reference.md).

## The repo block

```json
{
  "repo": {
    "url": "https://gitlab.com/acme/handbook",
    "label": "GitLab",
    "editBase": "https://gitlab.com/acme/handbook/-/edit/main/content"
  }
}
```

- `url` adds a repository link to the top bar.
- `label` is the accessible name for that link.
- `editBase` is prefixed to each page's path under `contentDir` to build the edit link.
  For GitHub the shape is `https://github.com/acme/handbook/edit/main/content`.

Leave `editBase` empty to suppress the edit link entirely.

## Tuning rule severity

Every diagnostic code can be reassigned or turned off:

```json
{
  "rules": {
    "MD047": "off",
    "MD043": "error",
    "MD063": "warning"
  }
}
```

Valid values are `"off"`, `"info"`, `"warning"` and `"error"`. An unknown code produces
`CFG002`; an unknown severity produces `CFG001`. The full list of codes is in
[Diagnostics](../reference/diagnostics.md).

Two overrides are worth knowing about:

- `"MD047": "off"` if your team writes bare URLs on purpose and does not want the
  reminder.
- `"MD043": "error"` if accessibility review requires alt text on every image.

## Strict mode

`strict: true` in the config, or `--strict` on the command line, makes warnings fatal.
Errors are always fatal.

```bash
md2spa build --strict
md2spa check --strict
```

The usual arrangement is a lenient local build and a strict CI job, so a warning blocks
the merge request without blocking the author mid-edit.

## Overrides on the command line

`--out`, `--base`, `--strict` and `--no-spa` override the config file for a single run.
Command-line values win; the file is otherwise untouched. This is what makes one config
serve both a root deployment and a preview deployment at a subpath.

```bash
md2spa build --out public --base /handbook/
```

## Unknown keys

An unrecognised top-level key produces `CFG002` at warning severity and is otherwise
ignored. A config written for a newer version of md2spa therefore still builds on an
older one — you get a warning per unsupported key rather than a hard failure.
