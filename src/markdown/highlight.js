/**
 * Build-time syntax highlighting.
 *
 * This is a *tokenizer*, not a parser. Each language is a short ordered list of regular
 * expressions; at first use they are compiled into a single alternation and the source is
 * scanned left to right. That buys ~90% of the visual value of a real grammar for a few
 * hundred lines and zero dependencies, and — because it runs at build time — the browser
 * never downloads a highlighter at all.
 *
 * Two properties are non-negotiable:
 *
 *   1. **Everything is escaped.** Source code must never become markup. Every byte leaves
 *      here through `escapeHtml()`, whether it was recognised as a token or not.
 *   2. **Work is bounded.** A 5 MB generated fence, or a pathological line, must not stall
 *      a build. Oversized input falls back to plain escaped text and the scan loop is
 *      capped and forced to advance on every iteration.
 *
 * Token classes follow SPEC 8b: `tok tok--{kw,str,num,com,fn,type,var,op,punc,attr,builtin,meta,ins,del}`.
 *
 * @module markdown/highlight
 */

import { escapeHtml } from '../util/html.js';

/** Above this many characters a fence is emitted as plain escaped text. */
const MAX_INPUT = 200 * 1024;

/** Hard ceiling on tokens per fence; the remainder is emitted as plain text. */
const MAX_TOKENS = 40000;

/**
 * Build a `\b(?:a|b|c)\b` matcher from a whitespace-separated word list.
 * Alternation order does not matter: the trailing `\b` forces a backtrack from `in`
 * to `instanceof` rather than accepting the short match.
 * @param {string} list
 * @returns {RegExp}
 */
function words(list) {
  return new RegExp(`\\b(?:${list.trim().split(/\s+/).join('|')})\\b`);
}

/**
 * Wrap text in a token span.
 * @param {string} tok token class suffix
 * @param {string} text raw source text
 * @returns {string}
 */
function span(tok, text) {
  return `<span class="tok tok--${tok}">${escapeHtml(text)}</span>`;
}

// --- markup-aware sub-renderers ------------------------------------------------------

const HTML_TAG_PARTS = /^(<\/?)([A-Za-z][\w:.-]*)([\s\S]*?)(\/?>)$/;
const HTML_ATTR = /([^\s"'=<>`/]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g;

/**
 * Re-tokenise a whole HTML/XML tag so the element name, attribute names and attribute
 * values get distinct classes. Done as a nested pass because a flat alternation cannot
 * tell "attribute name" from "bare word in prose".
 * @param {string} text the complete tag, angle brackets included
 * @returns {string}
 */
function renderTag(text) {
  const parts = HTML_TAG_PARTS.exec(text);
  if (!parts) return escapeHtml(text);

  const out = [span('punc', parts[1]), span('type', parts[2])];
  const rest = parts[3];
  let cursor = 0;
  let match;
  HTML_ATTR.lastIndex = 0;
  while ((match = HTML_ATTR.exec(rest)) !== null) {
    if (match[0] === '') { HTML_ATTR.lastIndex += 1; continue; }
    if (match.index > cursor) out.push(escapeHtml(rest.slice(cursor, match.index)));
    out.push(span('attr', match[1]));
    if (match[2]) out.push(span('op', match[2]));
    if (match[3]) out.push(span('str', match[3]));
    cursor = match.index + match[0].length;
  }
  if (cursor < rest.length) out.push(escapeHtml(rest.slice(cursor)));
  out.push(span('punc', parts[4]));
  return out.join('');
}

// --- shared rule fragments -----------------------------------------------------------

const C_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//;
const HASH_COMMENT = /(?<=^|\s)#[^\n]*/;
const DQ_STRING = /"(?:\\[\s\S]|[^"\\])*"/;
const SQ_STRING = /'(?:\\[\s\S]|[^'\\])*'/;
const C_NUMBER = /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?:[uUlLfFn]|UL|LL|ULL)?\b/;
const C_PUNC = /[{}[\]();,.]/;
const C_OP = /=>|\.{3}|[+\-*/%=<>!&|^~?:@]+/;

// --- language definitions ------------------------------------------------------------
// Rule order only decides ties at the *same* offset (the engine always takes the
// leftmost match), so "comment before operator" and "keyword before function call" are
// the orderings that matter.

const JS_RULES = [
  { t: 'meta', r: /^#![^\n]*/ },
  { t: 'com', r: C_COMMENT },
  { t: 'str', r: /`(?:\\[\s\S]|[^`\\])*`/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: SQ_STRING },
  { t: 'meta', r: /@[A-Za-z_$][\w$]*/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`as async await break case catch class const continue debugger default delete
      do else enum export extends finally for from function get if implements import in
      instanceof interface let new of package private protected public readonly return
      satisfies set static super switch this throw try typeof var void while with yield
      abstract declare infer is keyof namespace never override type unique asserts out`),
  },
  { t: 'kw', r: words('true false null undefined NaN Infinity') },
  { t: 'type', r: words('string number boolean any unknown object bigint symbol') },
  {
    t: 'builtin',
    r: words(`console document window globalThis Math JSON Object Array String Number
      Boolean Promise Symbol Map Set WeakMap WeakSet RegExp Error Date Proxy Reflect
      process require module exports fetch setTimeout setInterval clearTimeout
      clearInterval queueMicrotask structuredClone arguments`),
  },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_$]*\b/ },
  { t: 'fn', r: /\b[A-Za-z_$][\w$]*(?=\s*\()/ },
  { t: 'var', r: /\$[A-Za-z_$][\w$]*/ },
  { t: 'op', r: C_OP },
  { t: 'punc', r: C_PUNC },
];

const JSON_RULES = [
  { t: 'com', r: C_COMMENT },
  { t: 'attr', r: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/ },
  { t: 'str', r: DQ_STRING },
  { t: 'kw', r: words('true false null') },
  { t: 'num', r: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  { t: 'punc', r: /[{}[\],:]/ },
];

const BASH_RULES = [
  { t: 'meta', r: /^#![^\n]*/ },
  { t: 'com', r: HASH_COMMENT },
  { t: 'str', r: /<<-?\s*'?[A-Za-z_]\w*'?[\s\S]*?^\s*[A-Za-z_]\w*$/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'[^'\n]*'/ },
  { t: 'var', r: /\$\{[^}\n]*\}|\$\(\(|\$[A-Za-z_]\w*|\$[0-9@*#?$!_-]/ },
  { t: 'op', r: /^\s*[-\w]+=(?=\S)/ },
  {
    t: 'kw',
    r: words(`if then else elif fi for while until do done case esac in function select
      return break continue local export readonly declare typeset unset shift trap source
      eval exec alias set time coproc`),
  },
  {
    t: 'builtin',
    r: words(`echo printf read cd pwd pushd popd ls cat head tail less more grep egrep sed
      awk cut sort uniq tr wc find xargs curl wget git npm npx pnpm yarn node deno bun
      python python3 pip pip3 cargo go rustc make cmake gcc clang docker podman kubectl
      helm terraform ansible systemctl service sudo su apt apt-get yum dnf pacman apk brew
      chmod chown mkdir rmdir rm cp mv ln touch tar zip unzip gzip ssh scp rsync mount
      umount ps kill killall which whereis env export2 test true false exit sleep date`),
  },
  { t: 'num', r: /\b\d+\b/ },
  { t: 'op', r: /\|\||&&|[|&;]|\d?>>?|<<?|[!=]=|=~|--?[A-Za-z][\w-]*/ },
  { t: 'punc', r: /[{}()[\]]/ },
];

const PYTHON_RULES = [
  { t: 'com', r: HASH_COMMENT },
  { t: 'str', r: /(?:[rRbBuUfF]{0,2})(?:'''[\s\S]*?'''|"""[\s\S]*?""")/ },
  { t: 'str', r: /(?:[rRbBuUfF]{0,2})(?:"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*')/ },
  { t: 'meta', r: /^\s*@[\w.]+/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`and as assert async await break class continue def del elif else except
      finally for from global if import in is lambda nonlocal not or pass raise return try
      while with yield match case`),
  },
  { t: 'kw', r: words('True False None') },
  {
    t: 'builtin',
    r: words(`abs all any bool bytes callable chr dict dir enumerate eval filter float
      format frozenset getattr hasattr hash hex id input int isinstance issubclass iter
      len list map max min next object open ord pow print property range repr reversed
      round set setattr slice sorted staticmethod str sum super tuple type vars zip self
      cls __init__ __name__ __main__`),
  },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*\b/ },
  { t: 'fn', r: /\b[A-Za-z_]\w*(?=\s*\()/ },
  { t: 'op', r: C_OP },
  { t: 'punc', r: C_PUNC },
];

const RUST_RULES = [
  { t: 'com', r: C_COMMENT },
  { t: 'str', r: /b?r#*"[\s\S]*?"#*|b?"(?:\\[\s\S]|[^"\\])*"/ },
  { t: 'str', r: /b?'(?:\\[\s\S]|[^'\\])'/ },
  { t: 'meta', r: /#!?\[[^\]\n]*\]/ },
  { t: 'meta', r: /'[a-z_]\w*\b(?!')/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`as async await box break const continue crate dyn else enum extern fn for
      if impl in let loop match mod move mut pub ref return self Self static struct super
      trait type union unsafe use where while yield macro_rules`),
  },
  { t: 'kw', r: words('true false None Some Ok Err') },
  {
    t: 'type',
    r: words(`i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str
      String Vec Option Result Box Rc Arc RefCell Cell HashMap HashSet BTreeMap VecDeque`),
  },
  { t: 'builtin', r: /\b[a-z_]\w*!(?=[([{])/ },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*\b/ },
  { t: 'fn', r: /\b[a-z_]\w*(?=\s*(?:::<[^>\n]*>)?\s*\()/ },
  { t: 'op', r: /->|=>|::|[+\-*/%=<>!&|^~?]+/ },
  { t: 'punc', r: C_PUNC },
];

const GO_RULES = [
  { t: 'com', r: C_COMMENT },
  { t: 'str', r: /`[^`]*`/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'(?:\\[\s\S]|[^'\\])'/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`break case chan const continue default defer else fallthrough for func go
      goto if import interface map package range return select struct switch type var`),
  },
  { t: 'kw', r: words('true false nil iota') },
  {
    t: 'type',
    r: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32
      int64 rune string uint uint8 uint16 uint32 uint64 uintptr any`),
  },
  { t: 'builtin', r: words('append cap close copy delete len make new panic print println recover') },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*\b/ },
  { t: 'fn', r: /\b[A-Za-z_]\w*(?=\s*\()/ },
  { t: 'op', r: /:=|<-|\.{3}|[+\-*/%=<>!&|^~]+/ },
  { t: 'punc', r: C_PUNC },
];

const C_RULES = [
  { t: 'meta', r: /^[ \t]*#[ \t]*\w+/ },
  { t: 'com', r: C_COMMENT },
  { t: 'str', r: /(?<=include\s*)<[^>\n]*>/ },
  { t: 'str', r: /(?:u8|[uUL])?"(?:\\[\s\S]|[^"\\])*"/ },
  { t: 'str', r: /(?:u8|[uUL])?'(?:\\[\s\S]|[^'\\])'/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`alignas alignof asm auto break case catch class concept const consteval
      constexpr constinit const_cast continue co_await co_return co_yield decltype default
      delete do dynamic_cast else enum explicit export extern final for friend goto if
      inline mutable namespace new noexcept operator override private protected public
      register reinterpret_cast requires return sizeof static static_assert static_cast
      struct switch template this thread_local throw try typedef typeid typename union
      using virtual volatile while _Atomic _Static_assert`),
  },
  { t: 'kw', r: words('true false NULL nullptr') },
  {
    t: 'type',
    r: words(`bool char char8_t char16_t char32_t double float int long short signed
      unsigned void wchar_t size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t
      uint8_t uint16_t uint32_t uint64_t intptr_t uintptr_t FILE va_list`),
  },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*(?:_t)?\b/ },
  { t: 'fn', r: /\b[A-Za-z_]\w*(?=\s*\()/ },
  { t: 'op', r: /->|::|[+\-*/%=<>!&|^~?:]+/ },
  { t: 'punc', r: C_PUNC },
];

const JAVA_RULES = [
  { t: 'com', r: C_COMMENT },
  { t: 'str', r: /"""[\s\S]*?"""/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'(?:\\[\s\S]|[^'\\])'/ },
  { t: 'meta', r: /@[A-Za-z_]\w*/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`abstract assert break case catch class continue default do else enum extends
      final finally for goto if implements import instanceof interface native new package
      permits private protected public record return sealed static strictfp super switch
      synchronized this throw throws transient try var volatile while yield`),
  },
  { t: 'kw', r: words('true false null') },
  { t: 'type', r: words('boolean byte char double float int long short void String Object') },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*\b/ },
  { t: 'fn', r: /\b[A-Za-z_]\w*(?=\s*\()/ },
  { t: 'op', r: /->|::|[+\-*/%=<>!&|^~?:]+/ },
  { t: 'punc', r: C_PUNC },
];

const RUBY_RULES = [
  { t: 'com', r: /^=begin[\s\S]*?^=end|(?<=^|\s)#[^\n]*/ },
  { t: 'str', r: /%[wWiIqQ]?[[({][^\])}]*[\])}]/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'(?:\\[\s\S]|[^'\\])*'/ },
  { t: 'meta', r: /(?<![\w:]):[A-Za-z_]\w*[?!]?/ },
  { t: 'var', r: /@@?[A-Za-z_]\w*|\$[A-Za-z_]\w*/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`alias and begin break case class def defined do else elsif end ensure for if
      in module next not or redo rescue retry return self super then undef unless until
      when while yield lambda proc`),
  },
  { t: 'kw', r: words('true false nil __method__ __FILE__') },
  {
    t: 'builtin',
    r: words(`attr_accessor attr_reader attr_writer require require_relative include
      extend puts print p raise loop new freeze to_s to_i to_sym each map select reject`),
  },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*\b/ },
  { t: 'fn', r: /\b[a-z_]\w*[?!]?(?=\s*\()/ },
  { t: 'op', r: /=>|<=>|\|\||&&|[+\-*/%=<>!&|^~?:]+/ },
  { t: 'punc', r: C_PUNC },
];

const PHP_RULES = [
  { t: 'meta', r: /<\?php|<\?=|\?>/ },
  { t: 'com', r: /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\// },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'(?:\\[\s\S]|[^'\\])*'/ },
  { t: 'var', r: /\$[A-Za-z_]\w*/ },
  { t: 'num', r: C_NUMBER },
  {
    t: 'kw',
    r: words(`abstract and array as break callable case catch class clone const continue
      declare default do echo else elseif empty enddeclare endfor endforeach endif
      endswitch endwhile enum extends final finally fn for foreach function global goto if
      implements include include_once instanceof insteadof interface isset list match
      namespace new or print private protected public readonly require require_once return
      static switch throw trait try unset use var while xor yield`),
  },
  { t: 'kw', r: words('true false null TRUE FALSE NULL') },
  { t: 'type', r: /\b[A-Z][A-Za-z0-9_]*\b/ },
  { t: 'fn', r: /\b[A-Za-z_]\w*(?=\s*\()/ },
  { t: 'op', r: /=>|->|::|\?\?|[+\-*/%=<>!&|^~.?:]+/ },
  { t: 'punc', r: C_PUNC },
];

const MARKUP_RULES = [
  { t: 'com', r: /<!--[\s\S]*?-->/ },
  { t: 'meta', r: /<!DOCTYPE[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/ },
  {
    t: 'type',
    r: /<\/?[A-Za-z][\w:.-]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\/?>/,
    render: renderTag,
  },
  { t: 'builtin', r: /&[#\w]{1,10};/ },
];

const CSS_RULES = [
  { t: 'com', r: C_COMMENT },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: SQ_STRING },
  { t: 'meta', r: /@[\w-]+/ },
  { t: 'var', r: /--[\w-]+|\$[\w-]+/ },
  { t: 'kw', r: /[A-Za-z-]+(?=\s*:[^:])/ },
  { t: 'fn', r: /[\w-]+(?=\()/ },
  { t: 'num', r: /#[0-9a-fA-F]{3,8}(?![\w-])/ },
  { t: 'num', r: /-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]{1,4})?\b/ },
  { t: 'builtin', r: /!\s*important/ },
  { t: 'attr', r: /[.#][A-Za-z_-][\w-]*|::?[A-Za-z-]+|\[[^\]\n]*\]/ },
  { t: 'op', r: /[>~+*/=]/ },
  { t: 'punc', r: /[{}();:,]/ },
];

const YAML_RULES = [
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'(?:''|[^'\n])*'/ },
  { t: 'com', r: HASH_COMMENT },
  { t: 'meta', r: /^(?:---|\.\.\.)[^\n]*$/ },
  { t: 'meta', r: /(?<=^|\s)(?:[&*][\w.-]+|!!?[\w/.:-]*)/ },
  { t: 'attr', r: /(?<=^|\s)[\w.$/()'"-]+(?=\s*:(?:\s|$))/ },
  { t: 'kw', r: /\b(?:true|false|null|True|False|Null|TRUE|FALSE|NULL|yes|no|on|off|Yes|No|On|Off)\b|~(?=\s|$)/ },
  { t: 'num', r: /(?<=^|\s)-?\d+(?:\.\d+)?(?=\s|$|,|\])/ },
  { t: 'op', r: /(?<=^|\s)[|>][+-]?\d*(?=\s*$)/ },
  { t: 'punc', r: /^[ \t]*-(?=\s|$)|[[\]{},]/ },
];

const TOML_RULES = [
  { t: 'com', r: HASH_COMMENT },
  { t: 'type', r: /^[ \t]*\[\[?[^\]\n]*\]\]?/ },
  { t: 'str', r: /'''[\s\S]*?'''|"""[\s\S]*?"""/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'[^'\n]*'/ },
  { t: 'attr', r: /(?<=^|[\s,{])[A-Za-z0-9_.-]+(?=\s*=)/ },
  { t: 'kw', r: words('true false') },
  { t: 'num', r: /\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.]+(?:[Zz]|[+-]\d{2}:\d{2})?)?|-?\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b/ },
  { t: 'op', r: /=/ },
  { t: 'punc', r: /[[\]{},]/ },
];

const SQL_RULES = [
  { t: 'com', r: /--[^\n]*|\/\*[\s\S]*?\*\// },
  { t: 'str', r: /'(?:''|[^'])*'/ },
  { t: 'str', r: /"(?:""|[^"])*"|`[^`]*`/ },
  {
    t: 'kw',
    r: words(`add all alter and any as asc begin between by cascade case cast check
      collate column commit constraint create cross current_date current_timestamp
      database default delete desc distinct drop else end escape except exists explain
      first foreign from full grant group having if ilike in index inner insert intersect
      into is join key left like limit not null offset on or order outer over partition
      primary references rename replace return revoke right rollback row select set show
      table temporary then to transaction trigger truncate union unique update using
      vacuum values view when where window with`),
  },
  { t: 'kw', r: words('true false null') },
  {
    t: 'type',
    r: words(`bigint binary bit blob boolean bytea char clob date datetime decimal double
      float int integer interval json jsonb numeric real serial smallint text time
      timestamp timestamptz tinyint uuid varchar varbinary xml`),
  },
  { t: 'builtin', r: words('avg count max min sum coalesce nullif greatest least now length lower upper substring trim round abs') },
  { t: 'num', r: /\b\d+(?:\.\d+)?\b/ },
  { t: 'var', r: /[:@$]\w+|\?\d*/ },
  { t: 'op', r: /<>|!=|>=|<=|\|\||[+\-*/%=<>]/ },
  { t: 'punc', r: /[();,.]/ },
];

const INI_RULES = [
  { t: 'com', r: /(?<=^|\s)[;#][^\n]*/ },
  { t: 'type', r: /^[ \t]*\[[^\]\n]*\]/ },
  { t: 'attr', r: /^[ \t]*[\w.$-]+(?=[ \t]*[=:])/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'[^'\n]*'/ },
  { t: 'kw', r: words('true false yes no on off') },
  { t: 'num', r: /\b\d+(?:\.\d+)?\b/ },
  { t: 'op', r: /[=:]/ },
];

const DOCKERFILE_RULES = [
  { t: 'com', r: /^[ \t]*#[^\n]*/ },
  {
    t: 'kw',
    r: /^[ \t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|CROSS_BUILD)\b/,
  },
  { t: 'kw', r: /\bAS\b/ },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'[^'\n]*'/ },
  { t: 'var', r: /\$\{[^}\n]*\}|\$\w+/ },
  { t: 'num', r: /\b\d+\b/ },
  { t: 'op', r: /--[A-Za-z][\w-]*|[&|=\\]/ },
];

const MAKEFILE_RULES = [
  { t: 'com', r: /^[ \t]*#[^\n]*/ },
  { t: 'meta', r: /^\.[A-Z][A-Z_]*\b/ },
  { t: 'fn', r: /^[A-Za-z0-9_./%$(){}-]+(?=[ \t]*:(?!=))/ },
  { t: 'var', r: /\$[({][^)}\n]*[)}]|\$[@<^*?%+|]|\$\w/ },
  { t: 'kw', r: words('ifeq ifneq ifdef ifndef else endif include sinclude export unexport define endef override vpath') },
  { t: 'str', r: DQ_STRING },
  { t: 'str', r: /'[^'\n]*'/ },
  { t: 'op', r: /::=|:=|\+=|\?=|=/ },
];

const MARKDOWN_RULES = [
  { t: 'com', r: /<!--[\s\S]*?-->/ },
  { t: 'str', r: /^ {0,3}(?:```|~~~)[\s\S]*?^ {0,3}(?:```|~~~)/ },
  { t: 'str', r: /`[^`\n]+`/ },
  { t: 'kw', r: /^ {0,3}#{1,6}[ \t][^\n]*/ },
  { t: 'kw', r: /^[^\n]+\n[ \t]*(?:={3,}|-{3,})[ \t]*$/ },
  { t: 'op', r: /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/ },
  { t: 'punc', r: /^[ \t]*(?:[-*+]|\d+[.)])(?=\s)/ },
  { t: 'op', r: /^[ \t]*>+/ },
  { t: 'attr', r: /^ {0,3}\[[^\]\n]+\]:[^\n]*/ },
  { t: 'type', r: /!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]/ },
  { t: 'meta', r: /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~/ },
  { t: 'meta', r: /(?<!\w)_[^_\n]+_(?!\w)|(?<!\*)\*[^*\n]+\*(?!\*)/ },
  { t: 'builtin', r: /<https?:[^>\s]*>|\[\^[^\]\n]+\]/ },
];

/** `diff` is line-oriented; a token scanner is the wrong tool for it. */
const DIFF_LINE_RULES = [
  [/^(?:diff |index |similarity |rename |new file|deleted file|old mode|new mode)/, 'meta'],
  [/^(?:\+\+\+|---)(?:\s|$)/, 'meta'],
  [/^@@/, 'fn'],
  [/^\+/, 'ins'],
  [/^-/, 'del'],
  [/^\\/, 'com'],
];

/**
 * @typedef {Object} LanguageDef
 * @property {string} id canonical id
 * @property {string[]} aliases
 * @property {Array<{ t: string, r: RegExp, render?: (s: string) => string }>} [rules]
 * @property {Array<[RegExp, string]>} [lineRules]
 * @property {boolean} [ignoreCase]
 * @property {boolean} [plain] recognised, but deliberately not tokenised
 */

/** @type {LanguageDef[]} */
const LANGUAGE_DEFS = [
  { id: 'javascript', aliases: ['js', 'jsx', 'mjs', 'cjs', 'node', 'typescript', 'ts', 'tsx', 'mts', 'cts'], rules: JS_RULES },
  { id: 'json', aliases: ['jsonc', 'json5'], rules: JSON_RULES },
  { id: 'bash', aliases: ['sh', 'shell', 'zsh', 'ksh', 'bashrc'], rules: BASH_RULES },
  {
    id: 'console',
    aliases: ['shell-session', 'shellsession', 'terminal'],
    rules: [{ t: 'meta', r: /^[ \t]*[$#>][ \t]/ }, ...BASH_RULES.slice(1)],
  },
  { id: 'python', aliases: ['py', 'python3'], rules: PYTHON_RULES },
  { id: 'rust', aliases: ['rs'], rules: RUST_RULES },
  { id: 'go', aliases: ['golang'], rules: GO_RULES },
  { id: 'c', aliases: ['cpp', 'c++', 'cc', 'cxx', 'h', 'hpp', 'objc', 'cs', 'csharp'], rules: C_RULES },
  { id: 'java', aliases: ['kotlin', 'kt', 'groovy', 'scala'], rules: JAVA_RULES },
  { id: 'ruby', aliases: ['rb', 'gemfile'], rules: RUBY_RULES },
  { id: 'php', aliases: [], rules: PHP_RULES },
  { id: 'html', aliases: ['xml', 'svg', 'xhtml', 'vue', 'rss', 'atom', 'plist'], rules: MARKUP_RULES },
  { id: 'css', aliases: ['scss', 'sass', 'less', 'postcss'], rules: CSS_RULES },
  { id: 'yaml', aliases: ['yml'], rules: YAML_RULES },
  { id: 'toml', aliases: ['cargo'], rules: TOML_RULES },
  { id: 'sql', aliases: ['postgres', 'postgresql', 'mysql', 'sqlite', 'psql'], rules: SQL_RULES, ignoreCase: true },
  { id: 'diff', aliases: ['patch', 'udiff'], lineRules: DIFF_LINE_RULES },
  // `nginx` and `caddyfile` are not INI, but the directive/value/#-comment shape is close
  // enough that this tokenizer reads them correctly, and web-server config is common
  // enough in documentation to be worth the alias.
  { id: 'ini', aliases: ['conf', 'cfg', 'properties', 'editorconfig', 'gitconfig', 'nginx', 'caddyfile'], rules: INI_RULES },
  { id: 'dockerfile', aliases: ['docker', 'containerfile'], rules: DOCKERFILE_RULES },
  { id: 'makefile', aliases: ['make', 'mk', 'mak'], rules: MAKEFILE_RULES },
  { id: 'markdown', aliases: ['md', 'mdx', 'mkd'], rules: MARKDOWN_RULES },
  { id: 'plaintext', aliases: ['text', 'txt', 'plain', 'none', 'output', 'log'], plain: true },
];

/** @type {Map<string, LanguageDef>} */
const BY_ALIAS = new Map();
for (const def of LANGUAGE_DEFS) {
  BY_ALIAS.set(def.id, def);
  for (const alias of def.aliases) BY_ALIAS.set(alias, def);
}

/**
 * Every language id and alias the highlighter understands.
 * @type {ReadonlySet<string>}
 */
export const LANGUAGES = new Set(BY_ALIAS.keys());

/** Compiled scanners, keyed by canonical language id. */
const COMPILED = new Map();

/**
 * Count the capture groups in a pattern without executing it against real input:
 * appending `|` makes the whole thing match the empty string, so `exec('')` always
 * succeeds and its arity reveals the group count.
 * @param {string} source
 * @returns {number}
 */
function groupCount(source) {
  return new RegExp(`${source}|`).exec('').length - 1;
}

/**
 * Compile a language's rules into one alternation plus a group-index -> rule map.
 * @param {LanguageDef} def
 * @returns {{ re: RegExp, slots: number[] }}
 */
function compile(def) {
  const cached = COMPILED.get(def.id);
  if (cached) return cached;

  const slots = [];
  let group = 1;
  const sources = def.rules.map((rule) => {
    slots.push(group);
    group += 1 + groupCount(rule.r.source);
    return `(${rule.r.source})`;
  });
  const compiled = {
    re: new RegExp(sources.join('|'), def.ignoreCase ? 'gmi' : 'gm'),
    slots,
  };
  COMPILED.set(def.id, compiled);
  return compiled;
}

/**
 * Scan with a compiled rule set.
 * @param {string} code
 * @param {LanguageDef} def
 * @returns {string}
 */
function scan(code, def) {
  const { re, slots } = compile(def);
  const out = [];
  let cursor = 0;
  let tokens = 0;
  let match;
  re.lastIndex = 0;

  while ((match = re.exec(code)) !== null) {
    // A rule that can match the empty string would spin forever; step past it.
    if (match[0] === '') { re.lastIndex = match.index + 1; continue; }
    if (tokens >= MAX_TOKENS) break;
    tokens += 1;

    if (match.index > cursor) out.push(escapeHtml(code.slice(cursor, match.index)));

    let ruleIndex = -1;
    for (let i = 0; i < slots.length; i += 1) {
      if (match[slots[i]] !== undefined) { ruleIndex = i; break; }
    }
    const rule = ruleIndex === -1 ? null : def.rules[ruleIndex];
    out.push(rule
      ? (rule.render ? rule.render(match[0]) : span(rule.t, match[0]))
      : escapeHtml(match[0]));

    cursor = match.index + match[0].length;
    re.lastIndex = cursor; // belt and braces: never let lastIndex fall behind
  }

  if (cursor < code.length) out.push(escapeHtml(code.slice(cursor)));
  return out.join('');
}

/**
 * Scan line by line (used by `diff`, where the first character owns the whole line).
 * @param {string} code
 * @param {LanguageDef} def
 * @returns {string}
 */
function scanLines(code, def) {
  return code.split('\n').map((line) => {
    for (const [re, tok] of def.lineRules) {
      if (re.test(line)) return span(tok, line);
    }
    return escapeHtml(line);
  }).join('\n');
}

/**
 * Reduce a fence info string to a language key.
 * Handles `JS`, `.ts`, `js{1,3}`, `python:script.py` — anything after the first
 * non-identifier character is metadata, not a language.
 * @param {string|null|undefined} lang
 * @returns {string|null} null when no language was given at all
 */
function normalizeKey(lang) {
  if (lang === null || lang === undefined) return null;
  const raw = String(lang).trim().toLowerCase().replace(/^\./, '');
  if (!raw) return null;
  const key = /^[a-z0-9+#_-]+/.exec(raw);
  return key ? key[0] : raw;
}

/**
 * Highlight a code fence.
 *
 * `recognized` is false only when a language *was* declared and no rule set matches it —
 * that is what the renderer turns into MD022. A fence with no language, or one tagged
 * `plaintext`, is "recognised" with nothing to do.
 *
 * @param {string} code raw source, exactly as authored
 * @param {string|null} [lang] fence info word
 * @returns {{ html: string, recognized: boolean }}
 */
export function highlight(code, lang) {
  const source = String(code ?? '');
  const key = normalizeKey(lang);

  if (key === null) return { html: escapeHtml(source), recognized: true };

  const def = BY_ALIAS.get(key);
  if (!def) return { html: escapeHtml(source), recognized: false };

  // Huge fences are almost always generated output; tokenising them buys nothing and
  // can cost seconds across a whole site.
  if (def.plain || source.length > MAX_INPUT) {
    return { html: escapeHtml(source), recognized: true };
  }

  const html = def.lineRules ? scanLines(source, def) : scan(source, def);
  return { html, recognized: true };
}

/**
 * True when the highlighter has a rule set (or an explicit plaintext alias) for `lang`.
 * A missing/empty language counts as known — there is nothing to warn about.
 * @param {string|null|undefined} lang
 * @returns {boolean}
 */
export function isKnownLanguage(lang) {
  const key = normalizeKey(lang);
  return key === null || BY_ALIAS.has(key);
}
