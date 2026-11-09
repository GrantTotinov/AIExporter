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
  // `\section` commands, and `\%` escapes that aren't comments (LaTeX).
  backslashCommands?: boolean;
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
    // Text blocks
    tripleQuotes: true,
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
    tripleQuotes: true,
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
    // Raw string literals; #region, #if
    tripleQuotes: true,
    preprocessor: true,
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
    // #[derive(Debug)] attributes
    preprocessor: true,
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
  zig: {
    ...C_STYLE,
    blockComments: [],
    keywords: words(
      "addrspace align allowzero and anyframe anytype asm async await break " +
        "callconv catch comptime const continue defer else enum errdefer " +
        "error export extern fn for if inline linksection noalias noinline " +
        "nosuspend opaque or orelse packed pub resume return struct suspend " +
        "switch test threadlocal try union unreachable usingnamespace var " +
        "volatile while",
    ),
    literals: words("true false null undefined"),
    builtinTypes: words(
      "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f16 f32 f64 f80 " +
        "f128 bool void noreturn type anyerror anyopaque comptime_int " +
        "comptime_float c_char c_short c_ushort c_int c_uint c_long c_ulong " +
        "c_longlong c_ulonglong",
    ),
    capitalizedTypes: true,
    // Builtins: @import, @as, @Vector...
    annotations: true,
  },
  swift: {
    ...C_STYLE,
    tripleQuotes: true,
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
    // @media, @import
    annotations: true,
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
  dart: {
    ...C_STYLE,
    tripleQuotes: true,
    keywords: words(
      "abstract as assert async await base break case catch class const " +
        "continue covariant default deferred do dynamic else enum export " +
        "extends extension external factory final finally for get hide if " +
        "implements import in interface is late library mixin new on " +
        "operator part required rethrow return sealed set show static super " +
        "switch sync this throw try typedef var when while with yield",
    ),
    literals: words("true false null"),
    builtinTypes: words(
      "int double num bool void String List Map Set Future Stream Object Never",
    ),
    capitalizedTypes: true,
    annotations: true,
  },
  scala: {
    ...C_STYLE,
    tripleQuotes: true,
    keywords: words(
      "abstract case catch class def do else end enum export extends " +
        "extension final finally for given if implicit import lazy match new " +
        "object override package private protected return sealed super then " +
        "this throw trait try type using val var while with yield",
    ),
    literals: words("true false null"),
    builtinTypes: words(
      "Int Long Short Byte Char Float Double Boolean Unit String Any AnyRef " +
        "Nothing",
    ),
    capitalizedTypes: true,
    annotations: true,
  },
  r: {
    ...HASH_STYLE,
    keywords: words(
      "if else repeat while function for in next break return library require",
    ),
    literals: words(
      "TRUE FALSE NULL NA NaN Inf NA_integer_ NA_real_ NA_character_",
    ),
  },
  haskell: {
    lineComments: ["--"],
    blockComments: [["{-", "-}"]],
    // ' is also part of names (x'), so only " strings.
    quotes: ['"'],
    keywords: words(
      "as case class data default deriving do else family forall foreign " +
        "hiding if import in infix infixl infixr instance let module newtype " +
        "of qualified then type where",
    ),
    literals: words("True False Nothing Just Left Right otherwise"),
    builtinTypes: words(
      "Int Integer Float Double Char String Bool IO Maybe Either",
    ),
    capitalizedTypes: true,
  },
  elixir: {
    ...HASH_STYLE,
    tripleQuotes: true,
    keywords: words(
      "def defp defmodule defmacro defmacrop defstruct defprotocol defimpl " +
        "defdelegate defguard do end fn if else unless case cond with for " +
        "when in and or not try catch rescue after raise receive quote " +
        "unquote import require alias use",
    ),
    literals: words("true false nil"),
    capitalizedTypes: true,
    // @moduledoc, @spec
    annotations: true,
  },
  erlang: {
    lineComments: ["%"],
    blockComments: [],
    quotes: ['"', "'"],
    keywords: words(
      "after and andalso band begin bnot bor bsl bsr bxor case catch cond " +
        "div end fun if let not of or orelse receive rem try when xor module " +
        "export import record define include spec type",
    ),
    literals: words("true false undefined ok error"),
  },
  julia: {
    lineComments: ["#"],
    blockComments: [["#=", "=#"]],
    // ' is also transpose (A'), so only " strings.
    quotes: ['"'],
    tripleQuotes: true,
    keywords: words(
      "abstract baremodule begin break catch const continue do else elseif " +
        "end export finally for function global if import in isa let local " +
        "macro module mutable primitive quote return struct try type using " +
        "where while",
    ),
    literals: words("true false nothing missing NaN Inf"),
    builtinTypes: words(
      "Int Int8 Int16 Int32 Int64 UInt8 UInt16 UInt32 UInt64 Float32 " +
        "Float64 Bool Char String Vector Matrix Array Any Nothing Dict Tuple " +
        "Symbol",
    ),
    capitalizedTypes: true,
    // @time, @show macros
    annotations: true,
  },
  perl: {
    ...HASH_STYLE,
    keywords: words(
      "my our local sub if elsif else unless while until for foreach do last " +
        "next redo return use no package require print printf say die warn " +
        "eval and or not eq ne lt gt le ge cmp qw",
    ),
    literals: words("undef"),
    dollarVariables: true,
  },
  matlab: {
    lineComments: ["%"],
    blockComments: [["%{", "%}"]],
    quotes: ['"', "'"],
    keywords: words(
      "break case catch classdef continue else elseif end for function " +
        "global if otherwise parfor persistent return spmd switch try while " +
        "properties methods events",
    ),
    literals: words("true false pi inf Inf NaN nan eps"),
  },
  // OCaml and F#
  ocaml: {
    lineComments: ["//"],
    blockComments: [["(*", "*)"]],
    quotes: ['"'],
    keywords: words(
      "abstract and as assert async begin class constraint do done downto " +
        "else end exception external for fun function functor if in include " +
        "inherit initializer lazy let match member method module mutable " +
        "namespace new nonrec object of open or override private rec sig " +
        "struct then to try type use val virtual when while with yield",
    ),
    literals: words("true false None Some Ok Error"),
    builtinTypes: words(
      "int float bool char string unit list array option int64 int32 byte " +
        "decimal",
    ),
    capitalizedTypes: true,
  },
  // Lisp, Scheme, Clojure
  lisp: {
    lineComments: [";"],
    blockComments: [["#|", "|#"]],
    quotes: ['"'],
    keywords: words(
      "def defn defn- defmacro defun defvar defparameter defonce defrecord " +
        "defprotocol define define-syntax lambda fn let letrec loop recur if " +
        "when unless cond case do progn begin and or not ns require import " +
        "use setq quote",
    ),
    literals: words("true false nil"),
    dashedIdentifiers: true,
  },
  solidity: {
    ...C_STYLE,
    keywords: words(
      "pragma solidity contract interface library function modifier event " +
        "emit struct enum mapping public private internal external view pure " +
        "payable returns return if else for while do break continue new " +
        "delete using import is constructor fallback receive memory storage " +
        "calldata require revert assert override virtual abstract immutable " +
        "constant unchecked try catch error",
    ),
    literals: words(
      "true false wei gwei ether seconds minutes hours days weeks",
    ),
    builtinTypes: words(
      "address bool string bytes byte int uint int8 int16 int32 int64 " +
        "int128 int256 uint8 uint16 uint32 uint64 uint128 uint256 bytes4 " +
        "bytes32",
    ),
    capitalizedTypes: true,
  },
  graphql: {
    ...HASH_STYLE,
    quotes: ['"'],
    tripleQuotes: true,
    keywords: words(
      "query mutation subscription fragment on type interface union enum " +
        "input scalar schema extend implements directive",
    ),
    literals: words("true false null"),
    builtinTypes: words("Int Float String Boolean ID"),
    capitalizedTypes: true,
    dollarVariables: true,
    annotations: true,
  },
  dockerfile: {
    ...HASH_STYLE,
    keywords: words(
      "FROM AS RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT " +
        "VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL",
    ),
    literals: new Set(),
    dollarVariables: true,
    dashedIdentifiers: true,
  },
  makefile: {
    ...HASH_STYLE,
    keywords: words(
      "ifeq ifneq ifdef ifndef else endif include define endef export override",
    ),
    literals: new Set(),
    // `build:` targets
    keys: "bare",
    dollarVariables: true,
    dashedIdentifiers: true,
  },
  asm: {
    lineComments: [";", "//"],
    blockComments: [["/*", "*/"]],
    quotes: ['"', "'"],
    keywords: words(
      "mov movzx movsx lea push pop call ret jmp je jne jz jnz jg jge jl jle " +
        "ja jae jb jbe cmp test add sub mul imul div idiv inc dec and or xor " +
        "not neg shl shr sal sar nop int syscall loop ldr str ldp stp b bl bx " +
        "cbz cbnz section global extern db dw dd dq resb resw resd resq equ " +
        "times",
    ),
    literals: new Set(),
    builtinTypes: words(
      "eax ebx ecx edx esi edi esp ebp rax rbx rcx rdx rsi rdi rsp rbp r8 " +
        "r9 r10 r11 r12 r13 r14 r15 al ah bl bh cl ch dl dh ax bx cx dx sp lr " +
        "pc byte word dword qword ptr",
    ),
    caseInsensitive: true,
    // `_start:` labels
    keys: "bare",
  },
  // Terraform
  hcl: {
    lineComments: ["#", "//"],
    blockComments: [["/*", "*/"]],
    quotes: ['"'],
    keywords: words(
      "resource data variable output locals module provider terraform for " +
        "in if else endif endfor dynamic content",
    ),
    literals: words("true false null"),
    builtinTypes: words("string number bool list map set object tuple any"),
  },
  // Visual Basic, VBA, VBScript
  vb: {
    lineComments: ["'"],
    blockComments: [],
    quotes: ['"'],
    keywords: words(
      "AddressOf And AndAlso As ByRef ByVal Call Case Catch Class Const " +
        "Continue Declare Dim Do Each Else ElseIf End Enum Exit Finally For " +
        "Friend Function Get GoTo Handles If Implements Imports In Inherits " +
        "Interface Is IsNot Loop Me Mod Module MyBase Namespace New Next Not " +
        "Of On Option Optional Or OrElse Overrides Private Property Protected " +
        "Public ReDim Return Select Set Shared Static Step Structure Sub Then " +
        "Throw To Try Using When While With Xor Async Await",
    ),
    literals: words("True False Nothing"),
    builtinTypes: words(
      "Boolean Byte Char Date Decimal Double Integer Long Object Short " +
        "Single String Variant",
    ),
    caseInsensitive: true,
  },
  objectivec: {
    ...C_STYLE,
    keywords: words(`${C_KEYWORDS} self super`),
    literals: words("YES NO nil NULL true false"),
    builtinTypes: words(
      `${C_TYPES} id BOOL NSInteger NSUInteger CGFloat instancetype`,
    ),
    capitalizedTypes: true,
    preprocessor: true,
    // @interface, @property, @end
    annotations: true,
  },
  fortran: {
    lineComments: ["!"],
    blockComments: [],
    quotes: ['"', "'"],
    keywords: words(
      "program end module use implicit none integer real double precision " +
        "complex logical character parameter dimension allocatable intent " +
        "in out inout subroutine function call return if then else elseif " +
        "endif do enddo while select case contains print write read stop " +
        "allocate deallocate type interface",
    ),
    literals: new Set(),
    caseInsensitive: true,
  },
  // Pascal, Delphi
  pascal: {
    lineComments: ["//"],
    blockComments: [
      ["{", "}"],
      ["(*", "*)"],
    ],
    quotes: ["'"],
    keywords: words(
      "and array as begin case class const constructor destructor div do " +
        "downto else end except exit file finally for function goto if " +
        "implementation in inherited interface is label mod not object of " +
        "or packed private procedure program property protected public " +
        "published raise record repeat set shl shr then to try type unit " +
        "until uses var while with xor",
    ),
    literals: words("true false nil"),
    builtinTypes: words(
      "integer real boolean char byte word longint cardinal double single " +
        "extended string",
    ),
    caseInsensitive: true,
  },
  latex: {
    lineComments: ["%"],
    blockComments: [],
    quotes: [],
    keywords: new Set(),
    literals: new Set(),
    backslashCommands: true,
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
  cu: "cpp",
  cuda: "cpp",
  arduino: "cpp",
  ino: "cpp",
  glsl: "c",
  hlsl: "c",
  groovy: "java",
  gradle: "java",
  scala3: "scala",
  sc: "scala",
  hs: "haskell",
  elm: "haskell",
  purescript: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  jl: "julia",
  pl: "perl",
  pm: "perl",
  octave: "matlab",
  ml: "ocaml",
  fs: "ocaml",
  fsharp: "ocaml",
  "f#": "ocaml",
  clojure: "lisp",
  clj: "lisp",
  cljs: "lisp",
  edn: "lisp",
  scheme: "lisp",
  scm: "lisp",
  racket: "lisp",
  rkt: "lisp",
  elisp: "lisp",
  "emacs-lisp": "lisp",
  "common-lisp": "lisp",
  sol: "solidity",
  gql: "graphql",
  docker: "dockerfile",
  containerfile: "dockerfile",
  make: "makefile",
  mk: "makefile",
  assembly: "asm",
  nasm: "asm",
  masm: "asm",
  x86asm: "asm",
  armasm: "asm",
  terraform: "hcl",
  tf: "hcl",
  vba: "vb",
  vbnet: "vb",
  "vb.net": "vb",
  vbscript: "vb",
  objc: "objectivec",
  "objective-c": "objectivec",
  "obj-c": "objectivec",
  f90: "fortran",
  f95: "fortran",
  delphi: "pascal",
  pas: "pascal",
  tex: "latex",
};

/*
 * The language a fence's info string names (```ts,
 * ```python title="x.py", ```{r}), or undefined when it names none
 * this highlighter knows.
 */
export function resolveLanguage(info: string | undefined): string | undefined {
  const name = languageLabel(info)?.toLowerCase();

  if (!name) {
    return undefined;
  }

  const resolved = ALIASES[name] ?? name;

  return resolved in LANGUAGES || resolved === "html" || resolved === "diff"
    ? resolved
    : undefined;
}

/*
 * The language as the fence names it (```ts gives "ts"), shown
 * above the code block like on the chat page.
 */
export function languageLabel(info: string | undefined): string | undefined {
  return info
    ?.trim()
    .split(/[\s{},]/)
    .find(Boolean)
    ?.replace(/^language-/, "");
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

  if (/^<\?php\b/.test(text)) {
    return "php";
  }

  if (/^<(!DOCTYPE|html|\?xml|[a-z][\w-]*[\s>])/i.test(text)) {
    return "html";
  }

  if (/^#include\s*[<"]/m.test(text)) {
    return /\b(std::|class |template\s*<|namespace )/.test(text) ? "cpp" : "c";
  }

  // Before Python, whose `import x` it looks like
  if (/^import (SwiftUI|UIKit|Foundation)$/m.test(text)) {
    return "swift";
  }

  if (
    /^(def |class \w+(\(.*\))?:|from \S+ import |import \w+$)/m.test(text) &&
    !/[;{]\s*$/m.test(text)
  ) {
    return "python";
  }

  // Before JavaScript: `const std = @import("std");` looks like JS.
  if (/@import\("/.test(text)) {
    return "zig";
  }

  if (/^FROM \S+/m.test(text) && /^(RUN|COPY|CMD|ENTRYPOINT|WORKDIR) /m.test(text)) {
    return "dockerfile";
  }

  if (/\\(documentclass|begin\{\w+\})/.test(text)) {
    return "latex";
  }

  if (/^\s*using System\b/m.test(text)) {
    return "csharp";
  }

  if (/^\s*fun \w+\(/m.test(text) && /\b(val|var) \w+/.test(text)) {
    return "kotlin";
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

    if (rules.backslashCommands && char === "\\") {
      const match = /^\\(?:[A-Za-z@]+\*?|[^\n])?/.exec(code.slice(i)) as RegExpExecArray;
      sink.push(match[0], /^\\[A-Za-z@]/.test(match[0]) ? "keyword" : "plain");
      i += match[0].length;
      continue;
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
