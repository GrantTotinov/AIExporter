/*
 * =========================================================
 * CODE HIGHLIGHTING
 * =========================================================
 *
 * A small syntax highlighter for the PDF's code blocks. It splits
 * a block into colored tokens - keywords, strings, comments,
 * numbers, function names, types, tags - line by line, so the
 * renderer can keep wrapping lines by character count and just
 * draw each piece in its color.
 *
 * It is a tokenizer, not a parser: the aim is the look of an
 * editor's highlighting for the languages people paste into chats,
 * at a fraction of the size of a full highlighting library. Code
 * it doesn't recognize, and unfenced terminal output, is left
 * plain rather than guessed at wrongly.
 */

export type TokenKind =
  | "plain"
  | "keyword"
  | "literal"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "property"
  | "variable"
  | "meta"
  | "tag"
  | "attribute"
  | "inserted"
  | "deleted";

export interface CodeToken {
  text: string;
  kind: TokenKind;
}

interface LanguageRules {
  lineComments: string[];
  blockComments: [string, string][];
  quotes: string[];
  // Python's """ and ''' strings.
  tripleQuotes?: boolean;
  keywords: Set<string>;
  literals: Set<string>;
  builtinTypes?: Set<string>;
  // SQL and PowerShell keywords are matched in any case.
  caseInsensitive?: boolean;
  // Capitalized identifiers are classes/types (Java, C#, TS, ...).
  capitalizedTypes?: boolean;
  // `@Override` / `@decorator` annotations.
  annotations?: boolean;
  // `$name` / `${name}` variables (shell, PHP, PowerShell).
  dollarVariables?: boolean;
  // `#include` and friends at the start of a line.
  preprocessor?: boolean;
  // The first word of a command is the command's name (shell).
  commands?: boolean;
  // A string or word followed by ":" is a key: JSON's quoted keys,
  // YAML's and CSS's bare ones.
  keys?: "quoted" | "bare";
  // `#fff` colors (CSS).
  hexColors?: boolean;
  // Identifiers may contain "-" (CSS, shell flags, YAML keys).
  dashedIdentifiers?: boolean;
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/));

const C_KEYWORDS =
  "if else for while do switch case default break continue return goto " +
  "struct union enum typedef const static extern volatile register sizeof " +
  "inline";

const C_TYPES =
  "int char short long float double void signed unsigned bool size_t " +
  "int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t " +
  "auto wchar_t";

const C_STYLE = {
  lineComments: ["//"],
  blockComments: [["/*", "*/"]] as [string, string][],
  quotes: ['"', "'"],
};

const HASH_STYLE = {
  lineComments: ["#"],
  blockComments: [] as [string, string][],
  quotes: ['"', "'"],
};

const LANGUAGES: Record<string, LanguageRules> = {
  javascript: {
    ...C_STYLE,
    quotes: ['"', "'", "`"],
    keywords: words(
      "var let const function return if else for while do switch case " +
        "default break continue new delete typeof instanceof in of class " +
        "extends super this import export from as async await yield try " +
        "catch finally throw void with static get set debugger interface " +
        "type enum implements private protected public readonly abstract " +
        "declare namespace module keyof infer is satisfies override",
    ),
    literals: words("true false null undefined NaN Infinity"),
    builtinTypes: words(
      "string number boolean any unknown never object symbol bigint",
    ),
    capitalizedTypes: true,
    annotations: true,
  },
  python: {
    ...HASH_STYLE,
    tripleQuotes: true,
    keywords: words(
      "and as assert async await break class continue def del elif else " +
        "except finally for from global if import in is lambda nonlocal not " +
        "or pass raise return try while with yield match case self",
    ),
    literals: words("True False None"),
    builtinTypes: words(
      "int float str bool list dict set tuple bytes object type range",
    ),
    capitalizedTypes: true,
    annotations: true,
  },
  java: {
    ...C_STYLE,
    keywords: words(
      "abstract assert break case catch class continue default do else " +
        "enum extends final finally for if implements import instanceof " +
        "interface native new package private protected public return " +
        "static super switch synchronized this throw throws transient try " +
        "volatile while var record sealed permits yield",
    ),
    literals: words("true false null"),
    builtinTypes: words(
      "int long short byte char float double boolean void String",
    ),
    capitalizedTypes: true,
    annotations: true,
  },
  kotlin: {
    ...C_STYLE,
    keywords: words(
      "fun val var class object interface if else when for while do " +
        "return break continue import package is in as try catch finally " +
        "throw this super override open abstract private public protected " +
        "internal data sealed companion suspend lateinit init by",
    ),
    literals: words("true false null"),
    capitalizedTypes: true,
    annotations: true,
  },
  csharp: {
    ...C_STYLE,
    keywords: words(
      "abstract as base break case catch checked class const continue " +
        "default delegate do else enum event explicit extern finally fixed " +
        "for foreach goto if implicit in interface internal is lock " +
        "namespace new operator out override params private protected " +
        "public readonly ref return sealed sizeof stackalloc static struct " +
        "switch this throw try typeof unchecked unsafe using virtual while " +
        "var async await get set record init where yield",
    ),
    literals: words("true false null"),
    builtinTypes: words(
      "int long short byte char float double decimal bool void string " +
        "object uint ulong ushort sbyte dynamic",
    ),
    capitalizedTypes: true,
    annotations: true,
  },
  c: {
    ...C_STYLE,
    keywords: words(C_KEYWORDS),
    literals: words("true false NULL nullptr"),
    builtinTypes: words(C_TYPES),
    preprocessor: true,
  },
  cpp: {
    ...C_STYLE,
    keywords: words(
      `${C_KEYWORDS} class namespace template typename public private ` +
        "protected virtual override final new delete this throw try catch " +
        "using operator friend explicit constexpr noexcept static_cast " +
        "dynamic_cast reinterpret_cast const_cast decltype co_await " +
        "co_return co_yield concept requires",
    ),
    literals: words("true false NULL nullptr"),
    builtinTypes: words(`${C_TYPES} std string vector map`),
    capitalizedTypes: true,
    preprocessor: true,
  },
  go: {
    ...C_STYLE,
    quotes: ['"', "'", "`"],
    keywords: words(
      "break case chan const continue default defer else fallthrough for " +
        "func go goto if import interface map package range return select " +
        "struct switch type var",
    ),
    literals: words("true false nil iota"),
    builtinTypes: words(
      "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 " +
        "float64 string bool byte rune error any",
    ),
    capitalizedTypes: true,
  },
  rust: {
    ...C_STYLE,
    // A lone ' is a lifetime ('a) or char literal; only " strings
    // are scanned so lifetimes don't swallow the rest of the line.
    quotes: ['"'],
    keywords: words(
      "as async await break const continue crate dyn else enum extern fn " +
        "for if impl in let loop match mod move mut pub ref return self Self " +
        "static struct super trait type unsafe use where while",
    ),
    literals: words("true false None Some Ok Err"),
    builtinTypes: words(
      "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool " +
        "char str String Vec Option Result Box",
    ),
    capitalizedTypes: true,
  },
  swift: {
    ...C_STYLE,
    keywords: words(
      "class struct enum protocol extension func var let if else guard for " +
        "in while repeat switch case default break continue return import " +
        "init self super throw throws try catch do public private internal " +
        "fileprivate open static override mutating async await where",
    ),
    literals: words("true false nil"),
    capitalizedTypes: true,
    annotations: true,
  },
  php: {
    ...C_STYLE,
    lineComments: ["//", "#"],
    keywords: words(
      "abstract and as break case catch class clone const continue declare " +
        "default do echo else elseif empty extends final finally fn for " +
        "foreach function global if implements include instanceof interface " +
        "isset list match namespace new or print private protected public " +
        "require require_once include_once return static switch throw trait " +
        "try unset use var while yield",
    ),
    literals: words("true false null TRUE FALSE NULL"),
    capitalizedTypes: true,
    dollarVariables: true,
  },
  ruby: {
    ...HASH_STYLE,
    keywords: words(
      "alias and begin break case class def defined do else elsif end " +
        "ensure for if in module next not or redo rescue retry return self " +
        "super then undef unless until when while yield require puts",
    ),
    literals: words("true false nil"),
    capitalizedTypes: true,
  },
  bash: {
    ...HASH_STYLE,
    keywords: words(
      "if then else elif fi for while until do done case esac in function " +
        "return local export readonly declare unset shift source exit sudo",
    ),
    literals: words("true false"),
    dollarVariables: true,
    commands: true,
    dashedIdentifiers: true,
  },
  powershell: {
    lineComments: ["#"],
    blockComments: [["<#", "#>"]],
    quotes: ['"', "'"],
    keywords: words(
      "if else elseif foreach for while do switch function param return " +
        "try catch finally throw begin process end break continue in",
    ),
    literals: words("$true $false $null"),
    dollarVariables: true,
    caseInsensitive: true,
    commands: true,
    dashedIdentifiers: true,
  },
  sql: {
    lineComments: ["--"],
    blockComments: [["/*", "*/"]],
    quotes: ["'", '"', "`"],
    keywords: words(
      "select from where and or not insert into values update set delete " +
        "create table drop alter add column index view primary key foreign " +
        "references join inner left right outer full on as group by order " +
        "having limit offset distinct union all exists in between like is " +
        "case when then else end asc desc default unique check constraint " +
        "database if begin commit rollback transaction returning with",
    ),
    literals: words("null true false"),
    builtinTypes: words(
      "int integer bigint smallint serial varchar char text boolean bool " +
        "date timestamp time float real double decimal numeric json jsonb uuid",
    ),
    caseInsensitive: true,
  },
  json: {
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    quotes: ['"'],
    keywords: new Set(),
    literals: words("true false null"),
    keys: "quoted",
  },
  yaml: {
    ...HASH_STYLE,
    keywords: new Set(),
    literals: words("true false null yes no on off"),
    keys: "bare",
    dashedIdentifiers: true,
  },
  css: {
    lineComments: [],
    blockComments: [["/*", "*/"]],
    quotes: ['"', "'"],
    keywords: new Set(),
    literals: words("important"),
    keys: "bare",
    hexColors: true,
    dashedIdentifiers: true,
  },
  lua: {
    lineComments: ["--"],
    blockComments: [["--[[", "]]"]],
    quotes: ['"', "'"],
    keywords: words(
      "and break do else elseif end for function goto if in local not or " +
        "repeat return then until while",
    ),
    literals: words("true false nil"),
  },
};

const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "javascript",
  tsx: "javascript",
  typescript: "javascript",
  py: "python",
  python3: "python",
  py3: "python",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  "c#": "csharp",
  h: "c",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  golang: "go",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  shellscript: "bash",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql",
  sqlite: "sql",
  plsql: "sql",
  tsql: "sql",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  toml: "yaml",
  ini: "yaml",
  scss: "css",
  sass: "css",
  less: "css",
  htm: "html",
  xhtml: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  svelte: "html",
  patch: "diff",
};

/*
 * The language a fence's info string names (```ts,
 * ```python title="x.py", ```{r}), or undefined when it names none
 * this highlighter knows.
 */
export function resolveLanguage(info: string | undefined): string | undefined {
  const name = info
    ?.trim()
    .split(/[\s{},]/)
    .find(Boolean)
    ?.replace(/^language-/, "")
    .toLowerCase();

  if (!name) {
    return undefined;
  }

  const resolved = ALIASES[name] ?? name;

  return resolved in LANGUAGES || resolved === "html" || resolved === "diff"
    ? resolved
    : undefined;
}

/*
 * A block with no language named - an unfenced paste the exporter
 * fenced itself, or a fence without an info string - is only
 * highlighted when its language is obvious; anything else (git log
 * output, a stack trace, indented prose) stays plain.
 */
export function guessLanguage(code: string): string | undefined {
  const text = code.trim();

  if (/^[[{]/.test(text) && /"[^"\n]*"\s*:/.test(text)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // Not JSON after all; try the other languages.
    }
  }

  if (/^(diff --git|--- \S|\+\+\+ \S|@@ )/m.test(text) && /^[+-]/m.test(text)) {
    return "diff";
  }

  if (/^<(!DOCTYPE|html|\?xml|[a-z][\w-]*[\s>])/i.test(text)) {
    return "html";
  }

  if (/^#include\s*[<"]/m.test(text)) {
    return /\b(std::|class |template\s*<|namespace )/.test(text) ? "cpp" : "c";
  }

  if (
    /^(def |class \w+(\(.*\))?:|from \S+ import |import \w+$)/m.test(text) &&
    !/[;{]\s*$/m.test(text)
  ) {
    return "python";
  }

  if (
    /\b(function\s*\w*\s*\(|(const|let) \w+\s*=|console\.log|export (default|const|function)|import .* from ['"])|\) => /.test(
      text,
    )
  ) {
    return "javascript";
  }

  if (
    /^\s*(public |private |protected )?(static )?(final )?(class|interface) \w+/m.test(
      text,
    ) &&
    /;\s*$/m.test(text)
  ) {
    return "java";
  }

  if (
    /^\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/im.test(
      text,
    )
  ) {
    return "sql";
  }

  if (/^\s*(fn |let mut |use std::|impl )/m.test(text)) {
    return "rust";
  }

  if (/^\s*(package main|func \w+\(|import \()/m.test(text)) {
    return "go";
  }

  if (/^#!.*\b(ba|z)?sh\b/.test(text)) {
    return "bash";
  }

  return undefined;
}

/*
 * ---------------------------------------------------------
 * TOKENIZING
 * ---------------------------------------------------------
 */

class TokenSink {
  readonly tokens: CodeToken[] = [];

  push(text: string, kind: TokenKind): void {
    if (text === "") {
      return;
    }

    const last = this.tokens[this.tokens.length - 1];

    if (last && last.kind === kind) {
      last.text += text;
    } else {
      this.tokens.push({ text, kind });
    }
  }
}

/*
 * Splits a token stream into lines; a token spanning lines (a
 * block comment, a multi-line string) contributes a piece to each.
 */
function splitLines(tokens: CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [[]];

  for (const token of tokens) {
    token.text.split("\n").forEach((piece, index) => {
      if (index > 0) {
        lines.push([]);
      }

      if (piece !== "") {
        lines[lines.length - 1].push({ text: piece, kind: token.kind });
      }
    });
  }

  return lines;
}

const NUMBER_RE =
  /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;

// A key is followed by ":" - but not "::" (C++/Rust paths).
const KEY_COLON_RE = /^[ \t]*:(?!:)/;

/*
 * Where a string opened at `start` (just past its opening quote)
 * ends. Backslash escapes are skipped; a single-line string that
 * reaches the end of the line ends there, so an unbalanced quote
 * (an apostrophe in a shell comment-less echo) colors one line at
 * most.
 */
function scanQuoted(
  code: string,
  start: number,
  close: string,
  multiline: boolean,
): number {
  let i = start;

  while (i < code.length) {
    if (code[i] === "\\") {
      i += 2;
    } else if (code.startsWith(close, i)) {
      return i + close.length;
    } else if (code[i] === "\n" && !multiline) {
      return i;
    } else {
      i++;
    }
  }

  return code.length;
}

function restOfLine(code: string, start: number): number {
  const end = code.indexOf("\n", start);
  return end === -1 ? code.length : end;
}

function tokenizeWithRules(code: string, rules: LanguageRules): CodeToken[] {
  const sink = new TokenSink();
  const identStart = /[A-Za-z_]/;
  const identRe = rules.dashedIdentifiers
    ? /^[A-Za-z_][\w-]*/
    : /^[A-Za-z_$][\w$]*/;
  const normalize = (set: Set<string> | undefined): Set<string> =>
    new Set(
      [...(set ?? [])].map((word) =>
        rules.caseInsensitive ? word.toLowerCase() : word,
      ),
    );
  const keywords = normalize(rules.keywords);
  const literals = normalize(rules.literals);
  const types = normalize(rules.builtinTypes);
  const lookup = (word: string): string =>
    rules.caseInsensitive ? word.toLowerCase() : word;

  let i = 0;
  // True until the current line's (or command's) first word.
  let atCommandStart = true;
  let atLineStart = true;
  // CSS: a "name:" is a property inside a rule's braces, and part
  // of a selector (`a:hover`) outside them.
  let braceDepth = 0;

  const prevChar = (): string => (i > 0 ? code[i - 1] : "\n");

  while (i < code.length) {
    const char = code[i];

    if (char === "\n") {
      sink.push(char, "plain");
      atCommandStart = true;
      atLineStart = true;
      i++;
      continue;
    }

    if (char === " " || char === "\t") {
      sink.push(char, "plain");
      i++;
      continue;
    }

    const lineStart = atLineStart;
    const commandStart = atCommandStart;
    atLineStart = false;
    atCommandStart = false;

    const block = rules.blockComments.find(([open]) =>
      code.startsWith(open, i),
    );

    if (block) {
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? code.length : end + block[1].length;
      sink.push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    if (rules.preprocessor && lineStart && char === "#") {
      const stop = restOfLine(code, i);
      sink.push(code.slice(i, stop), "meta");
      i = stop;
      continue;
    }

    // A "#" comment needs whitespace before it, so `$#`, `a#b` and
    // URL fragments stay code; "//" after ":" is a URL, not a
    // comment.
    const lineComment = rules.lineComments.find((open) =>
      code.startsWith(open, i),
    );

    if (
      lineComment &&
      (lineComment !== "#" || /\s/.test(prevChar())) &&
      !(lineComment === "//" && prevChar() === ":")
    ) {
      const stop = restOfLine(code, i);
      sink.push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    if (rules.quotes.includes(char)) {
      const triple = char.repeat(3);
      const isTriple = rules.tripleQuotes && code.startsWith(triple, i);
      const close = isTriple ? triple : char;
      const stop = scanQuoted(
        code,
        i + close.length,
        close,
        Boolean(isTriple) || char === "`",
      );
      const isKey =
        rules.keys !== undefined && KEY_COLON_RE.test(code.slice(stop));
      sink.push(code.slice(i, stop), isKey ? "property" : "string");
      i = stop;
      continue;
    }

    if (rules.dollarVariables && char === "$") {
      const match = /^\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9#?@*!$-])/.exec(
        code.slice(i),
      );

      if (match) {
        const word = match[0];
        sink.push(word, literals.has(lookup(word)) ? "literal" : "variable");
        i += word.length;
        continue;
      }
    }

    if (rules.annotations && char === "@" && identStart.test(code[i + 1] ?? "")) {
      const match = /^@[\w.]+/.exec(code.slice(i));

      if (match) {
        sink.push(match[0], "meta");
        i += match[0].length;
        continue;
      }
    }

    // Numbers, unless they're the tail of an identifier (`x2`,
    // `utf-8`).
    if (/[\d.]/.test(char) && !/[\w$-]/.test(prevChar())) {
      const match = NUMBER_RE.exec(code.slice(i));

      if (match && /\d/.test(match[0])) {
        sink.push(match[0], "number");
        i += match[0].length;
        continue;
      }
    }

    if (rules.hexColors && char === "#") {
      const match = /^#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{3,4})(?![\w-])/.exec(
        code.slice(i),
      );

      if (match) {
        sink.push(match[0], "number");
        i += match[0].length;
        continue;
      }
    }

    // Shell flags (--force, -rf) are plain words, not commands.
    if (
      rules.commands &&
      char === "-" &&
      /\s/.test(prevChar()) &&
      /^--?[A-Za-z][\w-]*/.test(code.slice(i))
    ) {
      const match = /^--?[A-Za-z][\w-]*/.exec(code.slice(i)) as RegExpExecArray;
      sink.push(match[0], "attribute");
      i += match[0].length;
      continue;
    }

    if (identStart.test(char) || (char === "$" && !rules.dollarVariables)) {
      const match = identRe.exec(code.slice(i));

      if (match) {
        const word = match[0];
        const after = code.slice(i + word.length, i + word.length + 40);
        const key = lookup(word);
        let kind: TokenKind = "plain";

        if (
          rules.keys === "bare" &&
          KEY_COLON_RE.test(after) &&
          (!rules.hexColors || braceDepth > 0)
        ) {
          kind = "property";
        } else if (keywords.has(key)) {
          kind = "keyword";
        } else if (literals.has(key)) {
          kind = "literal";
        } else if (types.has(key)) {
          kind = "type";
        } else if (rules.commands && commandStart) {
          kind = "function";
        } else if (/^[ \t]*\(/.test(after)) {
          kind = "function";
        } else if (rules.capitalizedTypes && /^[A-Z][a-z0-9]\w*$/.test(word)) {
          kind = "type";
        }

        // A keyword like `sudo`, `then` or `do` is followed by a
        // command of its own.
        if (rules.commands && commandStart && kind === "keyword") {
          atCommandStart = true;
        }

        sink.push(word, kind);
        i += word.length;
        continue;
      }
    }

    // A shell prompt ("$ npm install", "> dir") leaves the command
    // after it a command.
    if (
      rules.commands &&
      lineStart &&
      (char === "$" || char === ">" || char === "%") &&
      code[i + 1] === " "
    ) {
      sink.push(char, "meta");
      atCommandStart = true;
      i++;
      continue;
    }

    // Pipes and separators start a new command.
    if (rules.commands && /[|;&(]/.test(char)) {
      atCommandStart = true;
    }

    if (char === "{") {
      braceDepth++;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }

    sink.push(char, "plain");
    i++;
  }

  return sink.tokens;
}

function tokenizeMarkup(code: string): CodeToken[] {
  const sink = new TokenSink();
  let i = 0;

  while (i < code.length) {
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4);
      const stop = end === -1 ? code.length : end + 3;
      sink.push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    const open = /^<\/?[A-Za-z!?][\w:.-]*/.exec(code.slice(i));

    if (open) {
      sink.push(open[0], "tag");
      i += open[0].length;

      // Attributes and their values, up to the tag's ">".
      while (i < code.length && code[i] !== ">") {
        const rest = code.slice(i);
        const attribute = /^[A-Za-z_:@#][\w:.@#-]*/.exec(rest);

        if (rest.startsWith("/>") || rest.startsWith("?>")) {
          break;
        } else if (attribute) {
          sink.push(attribute[0], "attribute");
          i += attribute[0].length;
        } else if (rest[0] === '"' || rest[0] === "'") {
          const end = code.indexOf(rest[0], i + 1);
          const stop = end === -1 ? code.length : end + 1;
          sink.push(code.slice(i, stop), "string");
          i = stop;
        } else {
          sink.push(code[i], "plain");
          i++;
        }
      }

      const close = /^[/?]?>/.exec(code.slice(i));

      if (close) {
        sink.push(close[0], "tag");
        i += close[0].length;
      }

      continue;
    }

    const entity = /^&#?\w+;/.exec(code.slice(i));

    if (entity) {
      sink.push(entity[0], "literal");
      i += entity[0].length;
      continue;
    }

    sink.push(code[i], "plain");
    i++;
  }

  return sink.tokens;
}

function diffLineKind(line: string): TokenKind {
  if (/^(\+\+\+|---)( |$)/.test(line) || /^(diff |index |@@)/.test(line)) {
    return "meta";
  }

  if (line.startsWith("+")) {
    return "inserted";
  }

  return line.startsWith("-") ? "deleted" : "plain";
}

/*
 * The code's tokens, one array per line (the line breaks
 * themselves not included). `info` is the fence's info string; a
 * language this highlighter doesn't know - or no language at all,
 * when none can be guessed - gives plain tokens.
 */
export function highlightCode(code: string, info?: string): CodeToken[][] {
  const language = info?.trim() ? resolveLanguage(info) : guessLanguage(code);

  if (language === "diff") {
    return code
      .split("\n")
      .map((line) => (line ? [{ text: line, kind: diffLineKind(line) }] : []));
  }

  const tokens =
    language === undefined
      ? [{ text: code, kind: "plain" as const }]
      : language === "html"
        ? tokenizeMarkup(code)
        : tokenizeWithRules(code, LANGUAGES[language]);

  return splitLines(tokens);
}
