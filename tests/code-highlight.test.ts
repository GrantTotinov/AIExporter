import { describe, expect, it } from "vitest";
import {
  guessLanguage,
  highlightCode,
  resolveLanguage,
  type CodeToken,
  type TokenKind,
} from "../src/code-highlight";

// The kind of each non-blank token, as "text:kind" pairs.
const kinds = (lines: CodeToken[][]): string[] =>
  lines
    .flat()
    .filter((token) => token.text.trim() !== "")
    .map((token) => `${token.text.trim()}:${token.kind}`);

const kindOf = (lines: CodeToken[][], text: string): TokenKind | undefined =>
  lines.flat().find((token) => token.text.trim() === text)?.kind;

describe("resolveLanguage", () => {
  it("maps aliases and ignores fence attributes", () => {
    expect(resolveLanguage("ts")).toBe("javascript");
    expect(resolveLanguage('python title="app.py"')).toBe("python");
    expect(resolveLanguage("{r}")).toBe("r");
    expect(resolveLanguage("objective-c")).toBe("objectivec");
    expect(resolveLanguage("F#")).toBe("ocaml");
    expect(resolveLanguage("Dockerfile")).toBe("dockerfile");
    expect(resolveLanguage("Shell")).toBe("bash");
    expect(resolveLanguage("language-yml")).toBe("yaml");
    expect(resolveLanguage("brainfuck")).toBeUndefined();
  });
});

describe("guessLanguage", () => {
  it("recognizes obvious languages", () => {
    expect(guessLanguage('{ "a": 1, "b": [true] }')).toBe("json");
    expect(guessLanguage("def main():\n    return 1")).toBe("python");
    expect(guessLanguage("const x = () => 1;")).toBe("javascript");
    expect(guessLanguage("#include <stdio.h>\nint main() {}")).toBe("c");
    expect(guessLanguage("SELECT * FROM users;")).toBe("sql");
    expect(guessLanguage("<div class=\"a\">hi</div>")).toBe("html");
    expect(guessLanguage('const std = @import("std");')).toBe("zig");
    expect(guessLanguage("<?php\necho 'hi';")).toBe("php");
    expect(guessLanguage("using System;\nclass A {}")).toBe("csharp");
    expect(guessLanguage("import SwiftUI\nlet x = 1")).toBe("swift");
    expect(guessLanguage("fun main() {\n    val x = 1\n}")).toBe("kotlin");
    expect(guessLanguage("FROM node:20\nRUN npm ci")).toBe("dockerfile");
    expect(guessLanguage("\\documentclass{article}")).toBe("latex");
  });

  it("leaves terminal output and prose plain", () => {
    expect(
      guessLanguage("commit 3159fb8\nAuthor: Dara\n\n    Fix the build"),
    ).toBeUndefined();
    expect(guessLanguage("Traceback (most recent call last):")).toBeUndefined();
  });
});

describe("highlightCode", () => {
  it("returns one token array per line", () => {
    const lines = highlightCode("a\n\nb", "js");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual([]);
    expect(lines.map((line) => line.map((t) => t.text).join(""))).toEqual([
      "a",
      "",
      "b",
    ]);
  });

  it("keeps every character of the source", () => {
    const code =
      'function f(x: number) {\n  /* multi\n  line */\n  return `a ${x}` + "b"; // done\n}';
    const lines = highlightCode(code, "ts");
    expect(lines.map((line) => line.map((t) => t.text).join("")).join("\n")).toBe(
      code,
    );
  });

  it("highlights JavaScript", () => {
    const lines = highlightCode(
      'const answer = compute(42, "x"); // why\nclass Foo extends Bar {}',
      "js",
    );
    expect(kindOf(lines, "const")).toBe("keyword");
    expect(kindOf(lines, "compute")).toBe("function");
    expect(kindOf(lines, "42")).toBe("number");
    expect(kindOf(lines, '"x"')).toBe("string");
    expect(kindOf(lines, "// why")).toBe("comment");
    expect(kindOf(lines, "Foo")).toBe("type");
  });

  it("splits multi-line comments and strings across lines", () => {
    const lines = highlightCode('x = """a\nb"""\n# c', "python");
    expect(kinds(lines)).toEqual([
      "x =:plain",
      '"""a:string',
      'b""":string',
      "# c:comment",
    ]);
  });

  it("highlights shell commands, flags and variables", () => {
    const lines = highlightCode("$ npm install --save-dev vite && echo $HOME", "bash");
    expect(kindOf(lines, "$")).toBe("meta");
    expect(kindOf(lines, "npm")).toBe("function");
    expect(kindOf(lines, "install")).toBe("plain");
    expect(kindOf(lines, "--save-dev")).toBe("attribute");
    expect(kindOf(lines, "echo")).toBe("function");
    expect(kindOf(lines, "$HOME")).toBe("variable");
  });

  it("doesn't treat a URL as a comment", () => {
    const lines = highlightCode('fetch("x"); go(https://a.io)', "js");
    expect(lines.flat().some((t) => t.kind === "comment")).toBe(false);
  });

  it("colors JSON keys apart from values", () => {
    const lines = highlightCode('{"name": "x", "n": 1, "ok": true}', "json");
    expect(kindOf(lines, '"name"')).toBe("property");
    expect(kindOf(lines, '"x"')).toBe("string");
    expect(kindOf(lines, "true")).toBe("literal");
  });

  it("matches SQL keywords in any case", () => {
    const lines = highlightCode("select id FROM users WHERE id = 1", "sql");
    expect(kindOf(lines, "select")).toBe("keyword");
    expect(kindOf(lines, "FROM")).toBe("keyword");
    expect(kindOf(lines, "users")).toBe("plain");
  });

  it("highlights markup tags and attributes", () => {
    const lines = highlightCode('<a href="/x">hi</a><!-- note -->', "html");
    expect(kinds(lines)).toEqual([
      "<a:tag",
      "href:attribute",
      "=:plain",
      '"/x":string',
      ">:tag",
      "hi:plain",
      "</a>:tag",
      "<!-- note -->:comment",
    ]);
  });

  it("tells CSS properties from pseudo-classes", () => {
    const lines = highlightCode("a:hover { color: #1f5bc7; }", "css");
    expect(kindOf(lines, "a")).not.toBe("property");
    expect(kindOf(lines, "color")).toBe("property");
    expect(kindOf(lines, "#1f5bc7")).toBe("number");
  });

  it("colors diff lines", () => {
    const lines = highlightCode("@@ -1 +1 @@\n-old\n+new\n same", "diff");
    expect(lines.map((line) => line[0]?.kind)).toEqual([
      "meta",
      "deleted",
      "inserted",
      "plain",
    ]);
  });

  it("highlights Zig", () => {
    const lines = highlightCode(
      'const std = @import("std");\npub fn add(a: u32, b: Point) !u32 {\n    return a orelse 0; // sum\n}',
      "zig",
    );
    expect(kindOf(lines, "pub")).toBe("keyword");
    expect(kindOf(lines, "orelse")).toBe("keyword");
    expect(kindOf(lines, "@import")).toBe("meta");
    expect(kindOf(lines, '"std"')).toBe("string");
    expect(kindOf(lines, "add")).toBe("function");
    expect(kindOf(lines, "u32")).toBe("type");
    expect(kindOf(lines, "Point")).toBe("type");
    expect(kindOf(lines, "// sum")).toBe("comment");
  });

  it.each([
    ["dart", "final name = 'x'; // c", "final", "keyword"],
    ["scala", "case class A(x: Int)", "case", "keyword"],
    ["r", "x <- function(a) NULL # c", "NULL", "literal"],
    ["haskell", "main = do -- c", "-- c", "comment"],
    ["elixir", "defmodule A do", "defmodule", "keyword"],
    ["erlang", "foo() -> ok. % c", "% c", "comment"],
    ["julia", "#= c =#\nfunction f(x::Int64)", "#= c =#", "comment"],
    ["perl", "my $x = undef;", "$x", "variable"],
    ["matlab", "%{\nc\n%}\nx = pi;", "pi", "literal"],
    ["fsharp", "let f x = x (* c *)", "(* c *)", "comment"],
    ["clojure", "(defn add-one [x] (inc x)) ; c", "defn", "keyword"],
    ["solidity", "uint256 public total;", "uint256", "type"],
    ["graphql", "query Get($id: ID!) { a }", "$id", "variable"],
    ["dockerfile", "FROM node AS build", "AS", "keyword"],
    ["makefile", "build: main.o", "build", "property"],
    ["nasm", "_start:\n  mov eax, 1 ; c", "eax", "type"],
    ["terraform", 'resource "aws_s3_bucket" "b" {}', "resource", "keyword"],
    ["vb", "Dim x As Integer ' c", "' c", "comment"],
    ["objc", "@interface Foo : NSObject", "@interface", "meta"],
    ["fortran", "PROGRAM hello ! c", "PROGRAM", "keyword"],
    ["delphi", "begin { c } end;", "{ c }", "comment"],
    ["latex", "\\section{A} 50\\% % c", "\\section", "keyword"],
    ["rust", "#[derive(Debug)]\nstruct A;", "#[derive(Debug)]", "meta"],
    ["css", "@media (max-width: 1px) {}", "@media", "meta"],
  ] as const)("highlights %s", (lang, code, text, kind) => {
    expect(kindOf(highlightCode(code, lang), text)).toBe(kind);
  });

  it("keeps LaTeX's \\% out of comments", () => {
    expect(kinds(highlightCode("50\\% done % note", "latex"))).toEqual([
      "50:number",
      "\\% done:plain",
      "% note:comment",
    ]);
  });

  it("colors a triple-quoted text block as one string", () => {
    const lines = highlightCode('String s = """\n  a "quoted" b\n""";', "java");
    expect(kindOf(lines, 'a "quoted" b')).toBe("string");
  });

  it("leaves unknown languages plain", () => {
    expect(highlightCode("if x then y", "cobol")).toEqual([
      [{ text: "if x then y", kind: "plain" }],
    ]);
  });
});
