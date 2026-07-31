/**
 * The diagnostic registry -- the heart of "tell me when my Markdown is wrong".
 *
 * Every rule has a stable code, a default severity and a one-line title. Severities are
 * user-overridable through `config.rules` (`'off' | 'info' | 'warning' | 'error'`), so a
 * team can dial the linter to their taste without patching the tool.
 *
 * @module markdown/diagnostics
 */

/** @typedef {'error'|'warning'|'info'} Severity */

/**
 * @typedef {Object} Diagnostic
 * @property {string} code
 * @property {Severity} severity
 * @property {string} message
 * @property {string|null} hint
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {number} endLine
 * @property {number} endColumn
 */

/**
 * @typedef {Object} Rule
 * @property {Severity} severity default severity
 * @property {string} title short human description
 */

/** @type {Readonly<Record<string, Rule>>} */
export const RULES = Object.freeze({
  // --- Frontmatter / file level -------------------------------------------------
  MD001: { severity: 'error',   title: 'malformed frontmatter' },
  MD002: { severity: 'error',   title: 'frontmatter value has the wrong type' },
  MD003: { severity: 'warning', title: 'file is empty' },
  MD004: { severity: 'info',    title: 'file uses CRLF line endings' },
  MD005: { severity: 'info',    title: 'file starts with a byte order mark' },

  // --- Headings -----------------------------------------------------------------
  MD010: { severity: 'error',   title: 'missing space after #' },
  MD011: { severity: 'warning', title: 'heading level skipped' },
  MD012: { severity: 'warning', title: 'multiple top-level headings' },
  MD013: { severity: 'warning', title: 'document has no title' },
  MD014: { severity: 'info',    title: 'duplicate heading anchor' },
  MD015: { severity: 'error',   title: 'empty heading' },

  // --- Code ---------------------------------------------------------------------
  MD020: { severity: 'error',   title: 'unclosed fenced code block' },
  MD021: { severity: 'warning', title: 'unmatched backtick run' },
  MD022: { severity: 'info',    title: 'unknown code language' },

  // --- Tables -------------------------------------------------------------------
  MD030: { severity: 'error',   title: 'table missing delimiter row' },
  MD031: { severity: 'warning', title: 'table row has the wrong number of cells' },
  MD032: { severity: 'error',   title: 'malformed table delimiter row' },

  // --- Links / images -----------------------------------------------------------
  MD040: { severity: 'error',   title: 'unclosed link or image' },
  MD041: { severity: 'error',   title: 'undefined link reference' },
  MD042: { severity: 'error',   title: 'empty link destination' },
  MD043: { severity: 'warning', title: 'image is missing alt text' },
  MD044: { severity: 'error',   title: 'internal link target does not exist' },
  MD045: { severity: 'warning', title: 'internal link anchor does not exist' },
  MD046: { severity: 'warning', title: 'referenced local asset does not exist' },
  MD047: { severity: 'info',    title: 'bare URL' },
  MD048: { severity: 'info',    title: 'unused link reference definition' },

  // --- Emphasis / inline / raw HTML ---------------------------------------------
  MD050: { severity: 'warning', title: 'unclosed emphasis marker' },
  MD051: { severity: 'warning', title: 'unclosed HTML tag' },
  MD052: { severity: 'warning', title: 'disallowed raw HTML' },

  // --- Lists / structure --------------------------------------------------------
  MD060: { severity: 'info',    title: 'inconsistent list marker' },
  MD061: { severity: 'info',    title: 'non-sequential ordered list' },
  MD062: { severity: 'warning', title: 'ambiguous list indentation' },
  MD063: { severity: 'info',    title: 'hard tab used for indentation' },
  MD064: { severity: 'error',   title: 'unclosed admonition block' },
  MD065: { severity: 'info',    title: 'trailing whitespace' },

  // --- Footnotes ----------------------------------------------------------------
  MD070: { severity: 'error',   title: 'undefined footnote reference' },
  MD071: { severity: 'info',    title: 'unreferenced footnote definition' },
  MD072: { severity: 'warning', title: 'duplicate footnote definition' },

  // --- Mermaid diagrams ---------------------------------------------------------
  MD080: { severity: 'info',    title: 'unsupported mermaid diagram type' },
  MD081: { severity: 'error',   title: 'mermaid syntax error' },
  MD082: { severity: 'warning', title: 'undeclared mermaid node or participant' },
  MD083: { severity: 'info',    title: 'mermaid init directive ignored' },
  MD084: { severity: 'warning', title: 'mermaid diagram exceeds the size limits' },

  // --- Config / site ------------------------------------------------------------
  CFG001: { severity: 'error',   title: 'config value has the wrong type' },
  CFG002: { severity: 'warning', title: 'unknown config key' },
  CFG003: { severity: 'error',   title: 'content directory not found' },
  NAV001: { severity: 'error',   title: 'duplicate route' },
  NAV002: { severity: 'info',    title: 'folder has no index page' },
  HTM001: { severity: 'error',   title: 'generated HTML failed verification' },
});

/** @type {ReadonlySet<Severity|'off'>} */
export const SEVERITIES = new Set(['off', 'info', 'warning', 'error']);

const SEVERITY_RANK = { info: 0, warning: 1, error: 2 };

/**
 * Order two diagnostics for stable, human-friendly reporting:
 * by file, then line, then column, then severity (worst first), then code.
 * @param {Diagnostic} a
 * @param {Diagnostic} b
 * @returns {number}
 */
export function compareDiagnostics(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (rank !== 0) return rank;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * Resolve a rule's effective severity given user overrides.
 * @param {string} code
 * @param {Record<string, string>} [overrides]
 * @returns {Severity|'off'}
 */
export function severityOf(code, overrides = {}) {
  const override = overrides[code];
  if (override && SEVERITIES.has(override)) return /** @type {Severity|'off'} */ (override);
  return RULES[code]?.severity ?? 'warning';
}

/**
 * A collector for one source file.
 *
 * `loc` accepts either `{ line, column, endLine, endColumn }` or a bare node/token
 * carrying `line`/`column`, so callers can pass AST nodes straight through.
 *
 * @param {string} file path relative to cwd, POSIX separators
 * @param {{ rules?: Record<string, string> }} [options]
 */
export function createBag(file, options = {}) {
  const overrides = options.rules || {};
  /** @type {Diagnostic[]} */
  const items = [];

  return {
    /**
     * @param {string} code
     * @param {{ line?: number, column?: number, endLine?: number, endColumn?: number }} loc
     * @param {string} [message] defaults to the rule title
     * @param {string|null} [hint]
     */
    add(code, loc, message, hint = null) {
      const severity = severityOf(code, overrides);
      if (severity === 'off') return;
      if (!RULES[code]) throw new Error(`Unknown diagnostic code: ${code}`);
      const line = Math.max(1, loc?.line ?? 1);
      const column = Math.max(1, loc?.column ?? 1);
      items.push({
        code,
        severity,
        message: message || RULES[code].title,
        hint,
        file,
        line,
        column,
        endLine: Math.max(line, loc?.endLine ?? line),
        endColumn: Math.max(1, loc?.endColumn ?? column + 1),
      });
    },
    /** @returns {Diagnostic[]} */
    list() {
      return items.slice().sort(compareDiagnostics);
    },
    /** @returns {boolean} */
    hasErrors() {
      return items.some((d) => d.severity === 'error');
    },
    /** @param {Diagnostic[]} more */
    absorb(more) {
      for (const d of more) items.push(d);
    },
    get size() {
      return items.length;
    },
  };
}

/**
 * Summarise a diagnostic list.
 * @param {Diagnostic[]} diagnostics
 * @returns {{ error: number, warning: number, info: number, total: number }}
 */
export function summarize(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0, total: diagnostics.length };
  for (const d of diagnostics) counts[d.severity] += 1;
  return counts;
}

/**
 * Should the process fail?
 * @param {Diagnostic[]} diagnostics
 * @param {boolean} strict when true, warnings are fatal too
 * @returns {boolean}
 */
export function shouldFail(diagnostics, strict = false) {
  return diagnostics.some(
    (d) => d.severity === 'error' || (strict && d.severity === 'warning'),
  );
}
