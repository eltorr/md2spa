/**
 * The `sequenceDiagram` parser.
 *
 * Sequence diagrams are line-oriented, so the scanner is too: one statement per line, no
 * backtracking, no cursor to advance past. That is deliberate -- it makes "a malformed
 * diagram must never hang the build" a property of the shape of the code rather than a
 * promise, and it keeps every diagnostic anchored to a real source line.
 *
 * The output is a flat event stream in document order. Blocks (`loop`/`alt`/`opt`/...)
 * appear as `block-start` / `block-section` / `block-end` markers sharing an `id` rather
 * than as a tree, because layout walks the diagram top to bottom assigning rows and only
 * needs to know a frame's vertical extent *after* it has laid out everything inside it.
 * A tree would have to be flattened again immediately.
 *
 * Participants are collected in first-appearance order. Undeclared ones are auto-created;
 * the `MD082` for those is deferred to the end of the parse so that a `participant` line
 * appearing *after* a mention -- legal, and common in hand-edited diagrams -- does not
 * produce a warning about a participant that turns out to be declared after all.
 *
 * @module markdown/mermaid/sequence/parse
 */

import { compareDiagnostics, severityOf } from '../../diagnostics.js';

/**
 * Hard ceilings from the mermaid spec; exceeding one is `MD084`, not a slow build.
 *
 * Collection stops one item *past* the ceiling rather than at it, so that a caller testing
 * `model.messages.length > MAX_MESSAGES` -- which is how `../index.js` decides whether to
 * fall back to a code block -- sees the breach instead of a model that stops exactly on the
 * limit and looks legal.
 */
export const MAX_PARTICIPANTS = 60;
export const MAX_MESSAGES = 400;

/** Source lines and block nesting are capped for the same reason. */
const MAX_LINES = 5000;
const MAX_BLOCK_DEPTH = 32;

/**
 * Arrow spellings, longest first -- the alternation is matched in this order, so `-->>`
 * has to be offered before `-->` or the trailing `>` would land in the target name.
 *
 * `head` is the arrowhead the renderer draws: `filled` a solid triangle, `open` a thin
 * unfilled V, `async` a single half barb, `cross` an X. `line` selects the stroke. `token`
 * is the author's own spelling, kept so the emitter can key off it directly.
 */
const ARROW_FORMS = Object.freeze([
  ['-->>', { token: '-->>', line: 'dotted', head: 'filled' }],
  ['--)', { token: '--)', line: 'dotted', head: 'async' }],
  ['--x', { token: '--x', line: 'dotted', head: 'cross' }],
  ['-->', { token: '-->', line: 'dotted', head: 'open' }],
  ['->>', { token: '->>', line: 'solid', head: 'filled' }],
  ['-)', { token: '-)', line: 'solid', head: 'async' }],
  ['-x', { token: '-x', line: 'solid', head: 'cross' }],
  ['->', { token: '->', line: 'solid', head: 'open' }],
]);

const ARROW_ALTERNATION = '-->>|--\\)|--[xX]|-->|->>|-\\)|-[xX]|->';
const MESSAGE_RE = new RegExp(`^(.*?)\\s*(${ARROW_ALTERNATION})\\s*([+-]?)\\s*(.*)$`);

const DIRECTIVE_RE = /^%%\{[\s\S]*\}%%$/;
const COMMENT_RE = /^%%/;
const HEADER_RE = /^sequenceDiagram\b/i;
const PARTICIPANT_RE = /^(participant|actor)\s+(.+)$/i;
const AS_RE = /\s+as\s+/i;
const ACTIVATION_RE = /^(activate|deactivate)\s+(.+)$/i;
const AUTONUMBER_RE = /^autonumber(?:\s+(off|\d{1,6}(?:\s+\d{1,6})?))?$/i;
const TITLE_RE = /^title\s*:?\s+(.+)$/i;
const NOTE_RE = /^note\s+(left\s+of|right\s+of|over)\s+([^:]+):\s?([\s\S]*)$/i;
const BLOCK_RE = /^(loop|alt|opt|par|critical|break|rect)(?:\s+([\s\S]*))?$/i;
const SECTION_RE = /^(else|and|option)(?:\s+([\s\S]*))?$/i;
const END_RE = /^end$/i;
const COLOUR_RE = /^(?:rgba?|hsla?)\([^)]*\)$|^#[0-9a-fA-F]{3,8}$/;

/** Keywords a section may follow. Mermaid is lenient here and so are we. */
const SECTION_KEYWORDS = Object.freeze({ else: 'else', and: 'and', option: 'option' });

const ENTITY_MAP = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
});

/**
 * @typedef {Object} SequenceParticipant
 * @property {string} id            the identifier used in messages
 * @property {string} label         display text (the `as` alias when given)
 * @property {'participant'|'actor'} kind
 * @property {boolean} declared     false when auto-created from a mention
 * @property {number} index         column order, left to right
 * @property {number} line          declaration line, or first mention when auto-created
 */

/**
 * @typedef {Object} SequenceArrow
 * @property {string} token  the author's spelling, e.g. `-->>`
 * @property {'solid'|'dotted'} line
 * @property {'filled'|'open'|'async'|'cross'} head
 */

/**
 * @typedef {Object} SequenceMessage
 * @property {'message'} type
 * @property {string} from
 * @property {string} to
 * @property {SequenceArrow} arrow
 * @property {string} text                 `\n` marks an author line break (`<br/>`)
 * @property {boolean} activateTarget      the `+` shorthand: activate `to`
 * @property {boolean} deactivateSource    the `-` shorthand: deactivate `from`
 * @property {number} line
 */

/**
 * @typedef {Object} SequenceNote
 * @property {'note'} type
 * @property {'left'|'right'|'over'} placement
 * @property {string[]} participants
 * @property {string} text
 * @property {number} line
 */

/**
 * @typedef {{ type: 'activate'|'deactivate', participant: string, line: number }} SequenceActivation
 * @typedef {{ type: 'block-start', id: number, keyword: string, label: string,
 *             colorHint: string|null, depth: number, line: number }} SequenceBlockStart
 * @typedef {{ type: 'block-section', id: number, keyword: string, label: string,
 *             depth: number, line: number }} SequenceBlockSection
 * @typedef {{ type: 'block-end', id: number, keyword: string, depth: number,
 *             line: number }} SequenceBlockEnd
 * @typedef {SequenceMessage|SequenceNote|SequenceActivation|SequenceBlockStart
 *           |SequenceBlockSection|SequenceBlockEnd} SequenceEvent
 */

/**
 * @typedef {Object} SequenceModel
 * @property {'sequence'} kind
 * @property {string|null} title
 * @property {SequenceParticipant[]} participants  column order, left to right
 * @property {SequenceEvent[]} events              document order
 * @property {SequenceMessage[]} messages          the message events, same objects
 * @property {boolean} autonumber
 * @property {number} autonumberStart
 * @property {number} autonumberStep
 * @property {boolean} overflow                    a size limit was hit; do not render
 * @property {number} messageCount
 */

/**
 * Decode the handful of character references authors actually type in diagram labels.
 * Anything else stays literal -- the renderer escapes the result, so an unrecognised
 * reference shows up as the text the author wrote instead of silently becoming something
 * else.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return match;
      // A lone surrogate is not serialisable: it survives in memory but degrades to U+FFFD
      // the moment the page is written as UTF-8, silently corrupting the label. The flowchart
      // decoder rejects the same range.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, name) ? ENTITY_MAP[name] : match;
  });
}

/**
 * Normalise label text: `<br/>` becomes a hard line break, entities are decoded, and
 * surrounding whitespace goes.
 * @param {string} raw
 * @returns {string}
 */
function cleanText(raw) {
  return decodeEntities(String(raw).replace(/<br\s*\/?>/gi, '\n')).trim();
}

/**
 * Strip one layer of matching quotes from an identifier or alias.
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  const text = String(raw).trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === '\'') && text[text.length - 1] === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Parse a `sequenceDiagram` body.
 *
 * @param {string} source the fence body, verbatim (a leading `sequenceDiagram` line is
 *        tolerated but not required)
 * @param {{ file?: string, line?: number, column?: number,
 *           rules?: Record<string, string>, reportDirectives?: boolean }} [ctx]
 *        `line`/`column` are the 1-based source position of the first content character,
 *        so diagnostics point into the Markdown file rather than into the fence.
 *        `reportDirectives: false` suppresses `MD083` for callers that already reported
 *        `%%{init}%%` directives while dispatching.
 * @returns {{ model: SequenceModel, diagnostics: import('../../diagnostics.js').Diagnostic[] }}
 */
export function parseSequence(source, ctx = {}) {
  const file = ctx.file || '';
  const baseLine = Math.max(1, ctx.line ?? 1);
  const baseColumn = Math.max(1, ctx.column ?? 1);
  const overrides = ctx.rules || {};
  const reportDirectives = ctx.reportDirectives !== false;

  /** @type {import('../../diagnostics.js').Diagnostic[]} */
  const diagnostics = [];

  /**
   * @param {string} code
   * @param {number} index 0-based line index within the fence body
   * @param {number} column 1-based column within that line
   * @param {number} length highlight length in characters
   * @param {string} message
   * @param {string|null} [hint]
   */
  const report = (code, index, column, length, message, hint = null) => {
    // Diagnostics are built here rather than through `createBag` because the caller owns the
    // bag: `../index.js` re-homes these onto the document's line numbers as it absorbs them.
    const severity = severityOf(code, overrides);
    if (severity === 'off') return;
    const line = baseLine + index;
    const col = baseColumn - 1 + Math.max(1, column);
    diagnostics.push({
      code,
      severity,
      message,
      hint,
      file,
      line,
      column: col,
      endLine: line,
      endColumn: col + Math.max(1, length),
    });
  };

  /** @type {Map<string, SequenceParticipant>} */
  const participants = new Map();
  /** @type {SequenceEvent[]} */
  const events = [];
  /** @type {SequenceMessage[]} */
  const messages = [];
  /**
   * Positions of the activations still open per participant, so an unbalanced `activate`
   * can be reported where it was written rather than at the end of the diagram.
   * @type {Map<string, Array<{ index: number, column: number, length: number }>>}
   */
  const activationLines = new Map();
  /** @type {Array<{ id: number, keyword: string, index: number, column: number }>} */
  const blockStack = [];

  const model = /** @type {SequenceModel} */ ({
    kind: 'sequence',
    title: null,
    participants: [],
    events,
    messages,
    autonumber: false,
    autonumberStart: 1,
    autonumberStep: 1,
    overflow: false,
    messageCount: 0,
  });

  let overflowed = false;
  let blockId = 0;
  let messageCount = 0;

  /**
   * Report a size limit once and stop consuming input.
   * @param {number} index
   * @param {string} what
   * @param {number} limit
   */
  const overflow = (index, what, limit) => {
    if (overflowed) return;
    overflowed = true;
    model.overflow = true;
    report('MD084', index, 1, 1,
      `sequence diagram exceeds the ${what} limit of ${limit}`,
      'Split it into several smaller diagrams; this one was not rendered.');
  };

  /**
   * Look a participant up, creating it on first mention.
   * @param {string} rawId
   * @param {number} index
   * @param {number} column
   * @returns {SequenceParticipant|null} null once the participant limit is reached
   */
  const touch = (rawId, index, column) => {
    const id = unquote(rawId);
    if (!id) return null;
    const existing = participants.get(id);
    if (existing) return existing;
    if (participants.size > MAX_PARTICIPANTS) {
      overflow(index, 'participant', MAX_PARTICIPANTS);
      return null;
    }
    /** @type {SequenceParticipant} */
    const created = {
      id,
      label: cleanText(id),
      kind: 'participant',
      declared: false,
      index: participants.size,
      line: baseLine + index,
      column,
    };
    participants.set(id, created);
    return created;
  };

  const rawLines = String(source).split(/\r\n|\r|\n/);
  if (rawLines.length > MAX_LINES) {
    overflow(0, 'source line', MAX_LINES);
    rawLines.length = MAX_LINES;
  }

  for (let index = 0; index < rawLines.length && !overflowed; index += 1) {
    const raw = rawLines[index];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Columns are reported against the original line, so remember where the trim started.
    const indent = raw.length - raw.trimStart().length;
    const col = indent + 1;

    if (DIRECTIVE_RE.test(trimmed)) {
      if (reportDirectives) {
        report('MD083', index, col, trimmed.length,
          'mermaid `%%{init}%%` directive ignored',
          'Diagram appearance comes from the site theme; style it with CSS instead.');
      }
      continue;
    }
    if (COMMENT_RE.test(trimmed)) continue;
    if (HEADER_RE.test(trimmed)) continue;

    const participantMatch = PARTICIPANT_RE.exec(trimmed);
    if (participantMatch) {
      const kind = participantMatch[1].toLowerCase() === 'actor' ? 'actor' : 'participant';
      const rest = participantMatch[2];
      const asAt = rest.search(AS_RE);
      const rawId = asAt === -1 ? rest : rest.slice(0, asAt);
      const alias = asAt === -1 ? null : rest.slice(asAt).replace(AS_RE, '');
      const entry = touch(rawId, index, col + participantMatch[1].length + 1);
      if (!entry) continue;
      // A declaration reaching an already-mentioned participant keeps its column but
      // upgrades it: order follows first appearance, appearance follows the source.
      entry.declared = true;
      entry.kind = kind;
      if (alias !== null) {
        const label = cleanText(unquote(alias));
        if (label) entry.label = label;
      }
      continue;
    }

    const activationMatch = ACTIVATION_RE.exec(trimmed);
    if (activationMatch) {
      const verb = activationMatch[1].toLowerCase();
      const nameColumn = col + activationMatch[1].length + 1;
      const entry = touch(activationMatch[2], index, nameColumn);
      if (!entry) continue;
      const open = activationLines.get(entry.id) || [];
      if (verb === 'activate') {
        open.push({ index, column: col, length: trimmed.length });
        activationLines.set(entry.id, open);
        events.push({ type: 'activate', participant: entry.id, line: baseLine + index });
      } else if (open.length === 0) {
        report('MD081', index, col, trimmed.length,
          `\`deactivate ${entry.id}\` has no matching \`activate\``,
          `Add \`activate ${entry.id}\` above, or use the \`+\`/\`-\` shorthand on the messages.`);
      } else {
        open.pop();
        events.push({ type: 'deactivate', participant: entry.id, line: baseLine + index });
      }
      continue;
    }

    const autonumberMatch = AUTONUMBER_RE.exec(trimmed);
    if (autonumberMatch) {
      const arg = (autonumberMatch[1] || '').trim();
      if (arg.toLowerCase() === 'off') {
        model.autonumber = false;
      } else {
        const [start, step] = arg ? arg.split(/\s+/).map(Number) : [];
        model.autonumber = true;
        model.autonumberStart = Number.isFinite(start) ? start : 1;
        model.autonumberStep = Number.isFinite(step) ? step : 1;
      }
      continue;
    }

    const titleMatch = TITLE_RE.exec(trimmed);
    if (titleMatch) {
      model.title = cleanText(titleMatch[1]) || null;
      continue;
    }

    const noteMatch = NOTE_RE.exec(trimmed);
    if (noteMatch) {
      const placement = noteMatch[1].toLowerCase().startsWith('left') ? 'left'
        : noteMatch[1].toLowerCase().startsWith('right') ? 'right' : 'over';
      const names = noteMatch[2].split(',');
      /** @type {string[]} */
      const targets = [];
      for (const name of names) {
        const entry = touch(name, index, col + trimmed.indexOf(name.trim()));
        if (entry && !targets.includes(entry.id)) targets.push(entry.id);
      }
      if (targets.length === 0) {
        report('MD081', index, col, trimmed.length,
          'note is missing the participant it belongs to',
          'Write `Note over A: text`, `Note left of A: text` or `Note right of A: text`.');
        continue;
      }
      if (placement !== 'over' && targets.length > 1) {
        // `left of`/`right of` anchor to a single lifeline; keep the first and say so.
        report('MD081', index, col, trimmed.length,
          `\`Note ${placement} of\` takes one participant, got ${targets.length}`,
          'Use `Note over A,B: text` to span several participants.');
        targets.length = 1;
      }
      events.push({
        type: 'note',
        placement,
        participants: targets,
        text: cleanText(noteMatch[3]),
        line: baseLine + index,
      });
      continue;
    }

    if (END_RE.test(trimmed)) {
      const open = blockStack.pop();
      if (!open) {
        report('MD081', index, col, trimmed.length,
          '`end` does not close anything',
          'Remove it, or add the matching `loop`/`alt`/`opt`/`par`/`critical`/`rect` above.');
      } else {
        events.push({
          type: 'block-end',
          id: open.id,
          keyword: open.keyword,
          depth: blockStack.length,
          line: baseLine + index,
        });
      }
      continue;
    }

    const sectionMatch = SECTION_RE.exec(trimmed);
    if (sectionMatch) {
      const keyword = SECTION_KEYWORDS[sectionMatch[1].toLowerCase()];
      const open = blockStack[blockStack.length - 1];
      if (!open) {
        report('MD081', index, col, trimmed.length,
          `\`${keyword}\` is not inside a block`,
          'Open an `alt`, `par` or `critical` above it, and close it with `end`.');
        continue;
      }
      events.push({
        type: 'block-section',
        id: open.id,
        keyword,
        label: cleanText(sectionMatch[2] || ''),
        depth: blockStack.length - 1,
        line: baseLine + index,
      });
      continue;
    }

    const blockMatch = BLOCK_RE.exec(trimmed);
    if (blockMatch) {
      if (blockStack.length >= MAX_BLOCK_DEPTH) {
        overflow(index, 'block nesting', MAX_BLOCK_DEPTH);
        continue;
      }
      const keyword = blockMatch[1].toLowerCase();
      const rawLabel = cleanText(blockMatch[2] || '');
      // `rect rgb(...)` names a fill. Colour belongs to the stylesheet, so it is recorded
      // and ignored rather than honoured.
      const isColour = keyword === 'rect' && COLOUR_RE.test(rawLabel);
      blockId += 1;
      blockStack.push({ id: blockId, keyword, index, column: col });
      events.push({
        type: 'block-start',
        id: blockId,
        keyword,
        label: isColour ? '' : rawLabel,
        colorHint: isColour ? rawLabel : null,
        depth: blockStack.length - 1,
        line: baseLine + index,
      });
      continue;
    }

    const messageMatch = MESSAGE_RE.exec(trimmed);
    if (messageMatch) {
      if (messageCount > MAX_MESSAGES) {
        overflow(index, 'message', MAX_MESSAGES);
        continue;
      }
      const shape = messageMatch[2].replace(/X/g, 'x');
      const arrow = ARROW_FORMS.find(([token]) => token === shape)?.[1];
      const tail = messageMatch[4];
      const colonAt = tail.indexOf(':');
      if (!arrow || colonAt === -1) {
        report('MD081', index, col, trimmed.length,
          'message is missing its `: text`',
          'Write `A->>B: text`. The colon is required even when the text is empty.');
        continue;
      }
      const fromEntry = touch(messageMatch[1], index, col);
      const toColumn = col + trimmed.length - tail.length;
      const toEntry = touch(tail.slice(0, colonAt), index, toColumn);
      if (!fromEntry || !toEntry) {
        if (!overflowed) {
          report('MD081', index, col, trimmed.length,
            'message is missing a sender or a receiver',
            'Write `A->>B: text` with a participant on each side of the arrow.');
        }
        continue;
      }
      const activateTarget = messageMatch[3] === '+';
      let deactivateSource = false;
      if (activateTarget) {
        const open = activationLines.get(toEntry.id) || [];
        open.push({ index, column: col, length: trimmed.length });
        activationLines.set(toEntry.id, open);
      }
      if (messageMatch[3] === '-') {
        const open = activationLines.get(fromEntry.id);
        if (!open || open.length === 0) {
          report('MD081', index, col, trimmed.length,
            `\`-\` deactivates \`${fromEntry.id}\`, which is not active`,
            `Activate it first with \`->>+${fromEntry.id}\` or \`activate ${fromEntry.id}\`.`);
        } else {
          open.pop();
          deactivateSource = true;
        }
      }
      messageCount += 1;
      /** @type {SequenceMessage} */
      const message = {
        type: 'message',
        from: fromEntry.id,
        to: toEntry.id,
        arrow,
        text: cleanText(tail.slice(colonAt + 1)),
        activateTarget,
        deactivateSource,
        line: baseLine + index,
      };
      events.push(message);
      messages.push(message);
      continue;
    }

    report('MD081', index, col, trimmed.length,
      `unrecognised statement \`${trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed}\``,
      'Expected a message like `A->>B: text`, or one of `participant`, `actor`, `Note`, '
      + '`activate`, `loop`, `alt`, `opt`, `par`, `critical`, `break`, `rect`, `autonumber`, `end`.');
  }

  // Anything still open at the end of the source is a real authoring error, reported where
  // the author can act on it: at the line that opened it.
  for (let i = blockStack.length - 1; i >= 0; i -= 1) {
    const open = blockStack[i];
    report('MD081', open.index, open.column, open.keyword.length,
      `\`${open.keyword}\` is never closed`,
      'Add `end` on its own line to close the block.');
    events.push({
      type: 'block-end',
      id: open.id,
      keyword: open.keyword,
      depth: i,
      line: baseLine + open.index,
    });
  }
  blockStack.length = 0;

  const ordered = [...participants.values()].sort((a, b) => a.index - b.index);
  for (const entry of ordered) {
    const open = activationLines.get(entry.id);
    if (!open) continue;
    for (const at of open) {
      report('MD081', at.index, at.column, at.length,
        `\`${entry.id}\` is activated here but never deactivated`,
        `Add \`deactivate ${entry.id}\`, or end a later message with \`-\` to close the bar.`);
    }
  }

  for (const entry of ordered) {
    if (entry.declared) continue;
    report('MD082', entry.line - baseLine, entry.column ?? 1, entry.id.length,
      `participant \`${entry.id}\` is not declared`,
      `Add \`participant ${entry.id}\` at the top to control where its column sits.`);
  }

  model.participants = ordered.map(({ id, label, kind, declared, index, line }) => ({
    id, label, kind, declared, index, line,
  }));
  model.messageCount = messageCount;

  return { model, diagnostics: diagnostics.sort(compareDiagnostics) };
}
