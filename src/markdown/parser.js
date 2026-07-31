/**
 * The public Markdown entry point.
 *
 * Normalises the source (BOM, CRLF), lifts the frontmatter off the top, then runs the
 * block lexer **twice**: once with diagnostics discarded, purely to harvest link
 * reference definitions, and once for real. That is what makes a forward reference work
 * --
 *
 *     See the [handbook][hb].
 *
 *     [hb]: https://example.com/handbook
 *
 * -- without either a special-cased pre-scan (which would trip over definitions inside
 * fenced code) or a fix-up pass over the finished tree.
 *
 * @module markdown/parser
 */

import path from 'node:path';
import { createBag } from './diagnostics.js';
import { parseFrontmatter } from './frontmatter.js';
import { tokenizeBlocks } from './lexer.js';
import { readTextFile, relPosix } from '../util/fs.js';
import { toPosix } from '../util/path.js';

/** @typedef {import('./diagnostics.js').Diagnostic} Diagnostic */
/** @typedef {{ type: string, line: number, column: number, [key: string]: any }} Inline */
/** @typedef {{ type: string, line: number, column: number, [key: string]: any }} Block */
/** @typedef {{ type: 'document', line: number, column: number, children: Block[] }} DocumentNode */

/** Container block types whose children may hide a link reference definition. */
const CONTAINERS = new Set(['blockquote', 'listItem', 'admonition', 'footnoteDefinition', 'list']);

/**
 * A bag that swallows everything. Used for the definition-harvesting pass so the same
 * finding is not reported twice.
 * @returns {{ add: Function, list: Function, hasErrors: Function, absorb: Function }}
 */
function silentBag() {
  return {
    add() {},
    absorb() {},
    list: () => [],
    hasErrors: () => false,
  };
}

/**
 * Walk a block tree collecting `definition` nodes. First definition of a label wins,
 * matching CommonMark.
 * @param {Block[]} blocks
 * @param {Map<string, { url: string, title: string|null, line: number, column: number }>} into
 */
function collectDefinitions(blocks, into) {
  for (const block of blocks) {
    if (block.type === 'definition') {
      if (!into.has(block.identifier)) {
        into.set(block.identifier, {
          url: block.url,
          title: block.title,
          line: block.line,
          column: block.column,
        });
      }
      continue;
    }
    if (CONTAINERS.has(block.type) && Array.isArray(block.children)) {
      collectDefinitions(block.children, into);
    }
  }
}

/**
 * Parse a Markdown document.
 *
 * @param {string} source raw file contents (a BOM and CRLF endings are handled here)
 * @param {Object} [options]
 * @param {string} [options.file] path relative to cwd, POSIX separators, for diagnostics
 * @param {object} [options.config] normalised config; `config.rules` overrides severities
 * @param {boolean} [options.hadBom] set by `readTextFile`, which strips the BOM for us
 * @param {boolean} [options.hadCrlf] set by `readTextFile`
 * @returns {{ ast: DocumentNode, frontmatter: Record<string, unknown>,
 *             definitions: Map<string, { url: string, title: string|null, line: number, column: number }>,
 *             diagnostics: Diagnostic[] }}
 */
export function parseMarkdown(source, options = {}) {
  const { file = '<input>', config = {}, hadBom = false, hadCrlf = false } = options;
  const bag = createBag(file, { rules: config.rules || {} });

  let text = String(source);

  // The flags let a caller that already used `readTextFile` report what it stripped;
  // inspecting the string covers everyone else.
  let bom = hadBom;
  if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1); }
  const crlf = hadCrlf || text.includes('\r\n');
  if (crlf || text.includes('\r')) text = text.replace(/\r\n?/g, '\n');

  if (bom) {
    bag.add('MD005', { line: 1, column: 1 }, 'file starts with a UTF-8 byte order mark',
      'Save the file as UTF-8 without a BOM; some tools render it as a stray character.');
  }
  if (crlf) {
    bag.add('MD004', { line: 1, column: 1 }, 'file uses CRLF line endings',
      'Normalise to LF -- add `*.md text eol=lf` to .gitattributes.');
  }

  const frontmatter = parseFrontmatter(text, bag);

  if (frontmatter.body.trim() === '') {
    bag.add('MD003', { line: frontmatter.bodyStartLine, column: 1 },
      text.trim() === '' ? 'file is empty' : 'file contains only frontmatter',
      'Add some content below the frontmatter, or delete the file.');
  }

  const lexOptions = {
    startLine: frontmatter.bodyStartLine,
    config,
    definitions: new Map(),
  };

  // Pass 1: harvest definitions so `[text][label]` resolves regardless of ordering.
  const definitions = new Map();
  collectDefinitions(
    tokenizeBlocks(frontmatter.body, { ...lexOptions, bag: silentBag() }),
    definitions,
  );

  // Pass 2: the real one.
  const children = tokenizeBlocks(frontmatter.body, { ...lexOptions, bag, definitions });

  return {
    ast: {
      type: 'document',
      line: 1,
      column: 1,
      children,
      // Carried on the node so `validateDocument(ast, { file, frontmatter, config })` -- the
      // signature SPEC 6 documents -- can point MD002 at the offending key without the
      // caller having to hand it the original source as an extra option.
      frontmatterRaw: frontmatter.raw,
      frontmatterStartLine: frontmatter.raw ? 2 : 0,
    },
    frontmatter: frontmatter.data,
    definitions,
    diagnostics: bag.list(),
  };
}

/**
 * Read and parse a file from disk.
 *
 * @param {string} absPath absolute path to the `.md` file
 * @param {Object} [options]
 * @param {string} [options.cwd] base for the diagnostic `file` field
 * @param {string} [options.file] explicit relative path, overriding `cwd`
 * @param {object} [options.config]
 * @returns {{ ast: DocumentNode, frontmatter: Record<string, unknown>,
 *             definitions: Map<string, object>, diagnostics: Diagnostic[],
 *             file: string, source: string }}
 */
export function parseMarkdownFile(absPath, options = {}) {
  const { cwd = process.cwd(), config = {} } = options;
  const { text, hadBom, hadCrlf } = readTextFile(absPath);
  const file = options.file
    ?? (path.isAbsolute(absPath) ? relPosix(cwd, absPath) : toPosix(absPath));

  return {
    ...parseMarkdown(text, { file, config, hadBom, hadCrlf }),
    file,
    source: text,
  };
}
