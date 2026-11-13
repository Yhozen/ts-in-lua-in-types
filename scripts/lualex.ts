// A Lua 5.4 tokenizer, just enough for the static census: names, keywords,
// numbers, strings (with their decoded value), symbols; comments are dropped
// but counted.

export type Kind = "name" | "keyword" | "number" | "string" | "longstring" | "symbol";

export interface Token {
  kind: Kind;
  text: string;
  /** Decoded value of a string literal. */
  value?: string;
  line: number;
}

const KEYWORDS = new Set(
  "and break do else elseif end false for function goto if in local nil not or repeat return then true until while".split(
    " ",
  ),
);

const SYMBOLS = [
  "...",
  "..",
  "::",
  "<<",
  ">>",
  "//",
  "==",
  "~=",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "#",
  "&",
  "~",
  "|",
  "<",
  ">",
  "=",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ";",
  ":",
  ",",
  ".",
];

export interface Lexed {
  tokens: Token[];
  comments: number;
  longComments: number;
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isNameStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isName = (c: string) => isNameStart(c) || isDigit(c);

function longBracket(src: string, i: number): number {
  // At '[': returns the level (number of '=') if this opens a long bracket, else -1.
  let j = i + 1;
  while (src[j] === "=") j++;
  return src[j] === "[" ? j - i - 1 : -1;
}

export function lex(src: string): Lexed {
  const tokens: Token[] = [];
  let comments = 0;
  let longComments = 0;
  let i = 0;
  let line = 1;
  const n = src.length;
  if (src.startsWith("#")) while (i < n && src[i] !== "\n") i++;
  const readLong = (level: number): string => {
    // i at the first '[' of the opener.
    const open = level + 2;
    let start = i + open;
    if (src[start] === "\r") start++;
    if (src[start] === "\n") start++;
    const close = "]" + "=".repeat(level) + "]";
    const end = src.indexOf(close, start);
    if (end < 0) throw new Error(`unfinished long string at line ${line}`);
    const body = src.slice(start, end);
    for (let k = i; k < end + close.length; k++) if (src[k] === "\n") line++;
    i = end + close.length;
    return body;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      comments++;
      i += 2;
      if (src[i] === "[" && longBracket(src, i) >= 0) {
        longComments++;
        readLong(longBracket(src, i));
      } else {
        while (i < n && src[i] !== "\n") i++;
      }
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isName(src[j]!)) j++;
      const text = src.slice(i, j);
      tokens.push({ kind: KEYWORDS.has(text) ? "keyword" : "name", text, line });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F.]/.test(src[j]!)) j++;
        if (src[j] === "p" || src[j] === "P") {
          j++;
          if (src[j] === "+" || src[j] === "-") j++;
          while (j < n && isDigit(src[j]!)) j++;
        }
      } else {
        while (j < n && /[0-9.]/.test(src[j]!)) j++;
        if (src[j] === "e" || src[j] === "E") {
          j++;
          if (src[j] === "+" || src[j] === "-") j++;
          while (j < n && isDigit(src[j]!)) j++;
        }
      }
      tokens.push({ kind: "number", text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") {
          const e = src[j + 1]!;
          j += 2;
          const simple: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            a: "\x07",
            b: "\b",
            f: "\f",
            v: "\v",
            "\\": "\\",
            '"': '"',
            "'": "'",
            "\n": "\n",
          };
          if (e in simple) {
            if (e === "\n") line++;
            value += simple[e];
          } else if (e === "x") {
            value += String.fromCharCode(parseInt(src.slice(j, j + 2), 16));
            j += 2;
          } else if (e === "z") {
            while (j < n && /\s/.test(src[j]!)) {
              if (src[j] === "\n") line++;
              j++;
            }
          } else if (e === "u") {
            const close = src.indexOf("}", j);
            value += String.fromCodePoint(parseInt(src.slice(j + 1, close), 16));
            j = close + 1;
          } else if (isDigit(e)) {
            let k = j - 1;
            let d = "";
            while (d.length < 3 && isDigit(src[k]!)) d += src[k++];
            value += String.fromCharCode(parseInt(d, 10));
            j = k;
          } else {
            value += e;
          }
        } else {
          value += src[j];
          j++;
        }
      }
      tokens.push({ kind: "string", text: src.slice(i, j + 1), value, line });
      i = j + 1;
      continue;
    }
    if (c === "[" && longBracket(src, i) >= 0) {
      const startLine = line;
      const start = i;
      const value = readLong(longBracket(src, i));
      tokens.push({ kind: "longstring", text: src.slice(start, i), value, line: startLine });
      continue;
    }
    const sym = SYMBOLS.find((s) => src.startsWith(s, i));
    if (!sym) throw new Error(`unexpected character ${JSON.stringify(c)} at line ${line}`);
    tokens.push({ kind: "symbol", text: sym, line });
    i += sym.length;
  }
  return { tokens, comments, longComments };
}
