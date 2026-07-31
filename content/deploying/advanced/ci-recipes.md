---
title: CI recipes
description: Lint gates, changed-file checks, link reports and reproducibility tests for any CI system.
order: 2
---

# CI recipes

Short, portable snippets. All of them assume nothing beyond a Node 18+ image, because
there is nothing else to assume.

## The two-job shape

Almost every docs pipeline wants the same two jobs:

- **lint** — runs on every push and every merge request, fails on broken links.
- **publish** — runs on the default branch only, builds and deploys.

Keeping them separate means a contributor sees the link error in thirty seconds instead of
waiting for a deploy that was never going to happen.

```bash
npx md2spa check --strict --format junit > report.xml
npx md2spa build --out public
```

## Fail on warnings, but only in CI

Locally, warnings should be visible and not fatal — an author mid-paragraph does not need
a build failure for an image that has no alt text yet. In CI they should block the merge.

Leave `strict: false` in the config and pass `--strict` in the pipeline. One flag, no
second config file, no environment-variable branching.

```yaml
lint:
  script:
    - npx md2spa check --strict
```

## Checking only what changed

On a large tree, checking every file on every push is wasteful. Pass the changed paths:

```bash
CHANGED=$(git diff --name-only origin/main...HEAD -- 'content/**/*.md')
if [ -n "$CHANGED" ]; then npx md2spa check --strict $CHANGED; fi
```

Cross-page rules still see the whole tree. `MD044` and `MD045` are evaluated against every
page regardless of which files you asked to check, because a link's validity depends on
pages you did not touch.

The `if` guard matters: with no arguments, `check` falls back to the whole content
directory, so an empty variable would silently check everything.

## Annotating a pull request

On GitHub, `--format github` turns each diagnostic into an inline annotation on the diff:

```yaml
      - run: npx md2spa check --format github
```

On GitLab, `--format junit` produces a test report that the merge request widget renders:

```yaml
lint:
  script:
    - npx md2spa check --format junit > report.xml
  artifacts:
    when: always
    reports:
      junit: report.xml
```

`when: always` is required. A failing job does not upload artifacts without it, and the
failing job is the one whose report you want.

## Verifying reproducibility

The build is deterministic: same input bytes, same output bytes. That is worth asserting,
because a regression here is invisible until it causes a mysterious cache miss.

```bash
npx md2spa build --out /tmp/a --quiet
npx md2spa build --out /tmp/b --quiet
diff -r /tmp/a /tmp/b && echo "reproducible"
```

The only key that can break this is `buildDate`. Leave it `null` unless you actually want
a date in the footer, and if you do, feed it a fixed value rather than the current time.

## Caching

There is nothing to cache. No `node_modules`, no lockfile, no build cache directory. A
cold pipeline and a warm one do the same work.

If your runner is slow to reach the npm registry, add md2spa as a dev dependency and let
your existing `npm ci` cache cover it. That is a network optimisation, not a build one.

## A scheduled link check

External links rot. Internal ones are checked on every build; external ones are not
fetched at all, because a build that depends on the network is a build that fails at
random.

Run an external check on a schedule instead, with a dedicated tool, and keep it out of the
blocking pipeline:

```yaml
link-rot:
  rules:
    - if: $CI_PIPELINE_SOURCE == 'schedule'
  script:
    - npx md2spa build --out public
    - your-link-checker public
  allow_failure: true
```

`allow_failure: true` is deliberate. Somebody else's server being down at 03:00 is not
your problem to be woken by.

## Building the docs from another repository

If the documentation lives beside the code it documents, build it from the code
repository's pipeline:

```yaml
docs:
  script:
    - npx md2spa build --config docs/md2spa.config.json --out public
  artifacts:
    paths:
      - public
```

`--config` sets the config file; `contentDir` inside it is resolved against the working
directory, so either run the job from `docs/` or use an absolute path.

## Exit codes to expect

| Code | Meaning | What CI should do |
|---:|:---|:---|
| `0` | Clean | Continue |
| `1` | Errors, or warnings under `--strict` | Fail the job. This is the normal failure |
| `2` | Bad usage | Fix the pipeline definition |
| `3` | Internal error | Report it. The stack trace is in the log |

Full details in the [CLI reference](../../reference/cli.md#exit-codes).
