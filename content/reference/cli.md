---
title: CLI
description: Every md2spa command and flag, with exit codes and the output formats the check command can emit.
---

# CLI

Five commands. Every flag is optional except the argument to `new`.

## Synopsis

```
md2spa build [--config <path>] [--out <dir>] [--base <path>] [--strict] [--no-spa] [--quiet]
md2spa dev   [--port 3000] [--host 127.0.0.1] [--open]
md2spa check [<paths...>] [--strict] [--format pretty|json|junit|github]
md2spa new   <route>
md2spa init
md2spa --version
md2spa --help
```

Flags accept both `--flag value` and `--flag=value`. Unknown flags are a usage error and
exit `2` rather than being ignored.

## build

Reads `contentDir`, writes a complete static site to `outDir`.

```bash
md2spa build
md2spa build --out public --strict
md2spa build --base /handbook/ --no-spa
```

| Flag | Default | Effect |
|:---|:---|:---|
| `--config <path>` | auto-detected | Use a specific config file instead of probing for one |
| `--out <dir>` | `dist` | Override `outDir` for this run |
| `--base <path>` | `auto` | Override `base`. See [Base paths](../deploying/advanced/base-paths.md) |
| `--strict` | off | Treat warnings as errors |
| `--no-spa` | off | Skip the SPA runtime and the JSON payloads |
| `--quiet` | off | Print only errors; suppress the per-page log and the summary |

`outDir` is emptied before the build, so anything you leave there by hand is deleted. The
directory itself is not removed, which keeps a running dev server's file handle valid.

`--no-spa` produces a plain multi-page site: no router, no client-side navigation, no
`_spa/` directory. Search still works, because the search index is a separate file. Use it
when the output is going somewhere that cannot serve JSON, or when you want the smallest
possible payload.

The command exits `1` if any error-severity diagnostic was produced, and writes nothing
further. With `--strict`, warnings do the same.

## dev

Builds the site, serves it, and rebuilds on every change.

```bash
md2spa dev
md2spa dev --port 8080 --host 0.0.0.0 --open
```

| Flag | Default | Effect |
|:---|:---|:---|
| `--port <n>` | `3000` | Port to listen on |
| `--host <addr>` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to reach it from another device |
| `--open` | off | Open the site in the default browser once it is ready |

The server watches `contentDir`, `staticDir`, `src/theme` and the config file, with an
80 ms debounce so a save that touches several files triggers one rebuild. When the rebuild
finishes it pushes a reload over server-sent events on `/__md2spa/events`. The client
snippet that listens for those events is injected in dev only and never appears in a
`build` output.

Diagnostics are reprinted on every rebuild. Draft pages are served, and badged in the
sidebar, so you can preview work that `build` would exclude.

Unknown paths are served `404.html` with a real 404 status, which is the same behaviour
most static hosts give you — so a routing bug shows up locally rather than in production.

## check

Parses and lints without writing anything.

```bash
md2spa check
md2spa check content/writing content/reference/cli.md
md2spa check --strict --format github
md2spa check --format junit > report.xml
md2spa check --list-rules
```

| Flag | Default | Effect |
|:---|:---|:---|
| `[<paths...>]` | `contentDir` | Files or directories to check |
| `--strict` | off | Treat warnings as errors |
| `--format <name>` | `pretty` | One of `pretty`, `json`, `junit`, `github` |
| `--list-rules` | — | Print every rule code with its default severity, then exit `0` |

Paths may be files or directories, and directories are walked recursively. Link and anchor
checking still runs against the *whole* content tree even when you check one file, because
`MD044` and `MD045` cannot be evaluated from a single page.

### Output formats

`pretty` is the default: coloured when the output is a terminal, plain when it is piped.

```
content/guide/install.md:12:3  error  MD030  table missing the delimiter row
   |
12 | | Feature | Status |
   |   ^
   = hint: add a row like `|---|---|` directly beneath the header row
```

`json` emits one object with a `diagnostics` array, each entry carrying `code`,
`severity`, `message`, `hint`, `file`, `line`, `column`, `endLine` and `endColumn`. Use it
to feed an editor plugin or a custom report.

`github` emits workflow annotations, so findings appear inline on the diff in a pull
request:

```
::error file=content/guide/install.md,line=12,col=3::MD030 table missing the delimiter row
```

`junit` emits JUnit XML, which GitLab CI renders as a test report on the merge request.
Redirect it to a file and declare it as an artifact:

```yaml
lint:
  script:
    - npx md2spa check --format junit > report.xml
  artifacts:
    reports:
      junit: report.xml
```

## new

Scaffolds a Markdown file with frontmatter already filled in.

```bash
md2spa new guide/advanced/tuning
```

That creates `content/guide/advanced/tuning.md`, creating intermediate directories as
needed, with a title humanised from the last segment:

```
---
title: Tuning
description: ''
---

# Tuning
```

The argument is a route, not a path: no leading slash, no `.md` extension. Asking for
`guide` creates `content/guide.md`; to create a section index, ask for `guide/index`. The
command refuses to overwrite an existing file and exits `2`.

## init

Scaffolds a new site in the current directory.

```bash
mkdir my-docs && cd my-docs
npx md2spa init
```

It writes `md2spa.config.json`, `content/index.md`, `content/_meta.json` and a `static/`
directory. Existing files are never overwritten; `init` in a directory that already has a
config reports what it skipped.

## Global flags

| Flag | Effect |
|:---|:---|
| `--version` | Print the version and exit `0` |
| `--help` | Print the command summary and exit `0` |

`md2spa <command> --help` prints the flags for that command.

## Exit codes

| Code | Meaning |
|---:|:---|
| `0` | Success. No error-severity diagnostics |
| `1` | Diagnostics failed the build: an error, or a warning under `--strict` |
| `2` | Bad usage: unknown command, unknown flag, missing argument |
| `3` | Internal error. This is a bug; the stack trace is printed |

Only `0` and `1` are expected in CI. Treat `2` as a broken pipeline definition and `3` as
something to report.

## Recipes

Build for GitLab Pages, which serves `public/`:

```bash
npx md2spa build --out public
```

Fail the pipeline on any warning, and produce a report the merge request can render:

```bash
npx md2spa check --strict --format junit > report.xml
```

Check only what changed, while still validating every cross-page link:

```bash
npx md2spa check $(git diff --name-only origin/main -- 'content/**/*.md')
```

Serve the built output on your network for review on a phone:

```bash
npx md2spa dev --host 0.0.0.0 --port 8080
```
