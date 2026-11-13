// The static census of the Lua code on tslua's check path -> docs/CENSUS.md.
//
//   vp run census
//
// Module set: every module in `package.loaded` after checking each input (both
// lib modes; the union over all inputs), plus the modules those modules
// `require` from inside a function body that no input loaded ("lazy"). Over
// that set it counts library references, syntax features, metamethods, and
// the literal formats and patterns given to string.format, string.pack and
// the pattern functions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lex, type Token } from "./lualex.ts";
import { byName, code, esc, n, sorted, table } from "./md.ts";
import { inputPath, listInputs } from "./oracle.ts";
import { runPool, type Job } from "./pool.ts";
import { root, tsluaSrc, type Lib } from "./tslua.ts";

const LIBS = ["string", "table", "math", "utf8", "os", "io", "debug", "coroutine", "package"];
const BASE = new Set(
  "assert collectgarbage dofile error getmetatable ipairs load loadfile next pairs pcall print rawequal rawget rawlen rawset require select setmetatable tonumber tostring type xpcall warn unpack".split(
    " ",
  ),
);
const STRING_FNS = new Set(
  "byte char dump find format gmatch gsub len lower match pack packsize rep reverse sub unpack upper".split(
    " ",
  ),
);
const PATTERN_FNS = new Set(["find", "match", "gmatch", "gsub"]);
const EVENTS = [
  "__index",
  "__newindex",
  "__call",
  "__eq",
  "__lt",
  "__le",
  "__len",
  "__tostring",
  "__concat",
  "__close",
  "__mode",
  "__pairs",
  "__gc",
  "__name",
  "__metatable",
  "__add",
  "__sub",
  "__mul",
  "__div",
  "__mod",
  "__pow",
  "__unm",
  "__idiv",
  "__band",
  "__bor",
  "__bxor",
  "__shl",
  "__shr",
  "__bnot",
];

export function moduleFile(name: string): string | undefined {
  if (name === "tsc") return join(root, "lua/tsc.lua");
  const base = join(tsluaSrc, ...name.split("."));
  for (const p of [`${base}.lua`, join(base, "init.lua")]) if (existsSync(p)) return p;
  return undefined;
}

const LOADED = `
local t = {}
for k in pairs(package.loaded) do
  if k == "tsc" or string.sub(k, 1, 6) == "tslua." then t[#t + 1] = k end
end
table.sort(t)
return table.concat(t, "\\n")`;

/** Modules in package.loaded after checking every input, per lib mode. */
export async function loadedModules(): Promise<Record<Lib["name"], Set<string>>> {
  const names = listInputs();
  const jobs: Job[] = [];
  for (const lib of ["mini", "es5"] as const)
    for (const name of names)
      jobs.push({
        id: jobs.length,
        source: readFileSync(inputPath(name), "utf8"),
        lib,
        options: { epilogue: LOADED },
      });
  const results = await runPool(jobs, () => {});
  const out = { mini: new Set<string>(), es5: new Set<string>() };
  for (const r of results) for (const m of r.result.extra!.split("\n")) out[jobs[r.id]!.lib].add(m);
  return out;
}

interface Counter {
  [k: string]: number;
}
const bump = (c: Counter, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};

/** Index just past the expression argument starting at i (stops at a depth-0 ',' or ')'). */
function skipArg(toks: Token[], i: number): number {
  let depth = 0;
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "symbol") {
      if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") {
        if (depth === 0) return i;
        depth--;
      } else if (t.text === "," && depth === 0) return i;
    } else if (t.kind === "keyword" && t.text === "function") {
      // Skip a function body: count block openers until the matching end.
      let d = 0;
      for (; i < toks.length; i++) {
        const u = toks[i]!;
        if (u.kind !== "keyword") continue;
        if (u.text === "function" || u.text === "do" || u.text === "if" || u.text === "repeat") d++;
        else if (u.text === "end" || u.text === "until") {
          d--;
          if (d === 0) break;
        }
      }
    }
  }
  return i;
}

/** Literal argument at i: the string value if the whole argument is one string literal. */
function literalArg(toks: Token[], i: number): string | undefined {
  const t = toks[i];
  if (!t || (t.kind !== "string" && t.kind !== "longstring")) return undefined;
  const next = toks[i + 1];
  return next && next.kind === "symbol" && (next.text === "," || next.text === ")")
    ? t.value
    : undefined;
}

/** Arguments of a call whose '(' is at i: start index of each argument. */
function args(toks: Token[], open: number): number[] {
  const starts: number[] = [];
  let i = open + 1;
  if (toks[i]?.text === ")") return starts;
  while (i < toks.length) {
    starts.push(i);
    i = skipArg(toks, i);
    if (toks[i]?.text !== ",") break;
    i++;
  }
  return starts;
}

const argKind = (toks: Token[], i: number | undefined): string => {
  if (i === undefined) return "none";
  const t = toks[i]!;
  if (t.kind === "string" || t.kind === "longstring")
    return literalArg(toks, i) !== undefined ? "string" : "expr";
  if (t.kind === "keyword" && t.text === "function") return "function";
  if (t.text === "{") return "table";
  if (t.kind === "name") {
    const end = skipArg(toks, i);
    return end === i + 1 ? "name" : "expr";
  }
  return "expr";
};

interface PatternUse {
  fn: string;
  count: number;
}

export interface Census {
  modules: string[];
  lib: Counter;
  stringMethods: Counter;
  base: Counter;
  syntax: Counter;
  bigInts: Counter;
  metamethods: Counter;
  formats: Map<string, number>;
  packFormats: Map<string, Counter>;
  patterns: Map<string, PatternUse[]>;
  patternFeatures: Counter;
  nonLiteral: Counter;
  gsubRepl: Counter;
  plainFind: number;
  requiresTop: Map<string, Set<string>>;
  requiresLazy: Map<string, Set<string>>;
  dynamicRequires: number;
  where: Map<string, Set<string>>;
  lines: number;
  bytes: number;
  functions: number;
}

const BIG = 2n ** 53n;

function patternFeatures(p: string, out: Set<string>) {
  if (p.startsWith("^")) out.add("anchor ^");
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "%") {
      const e = p[i + 1] ?? "";
      i++;
      if (/[acdglpsuwx]/.test(e)) out.add(`class %${e}`);
      else if (/[ACDGLPSUWX]/.test(e)) out.add(`class %${e} (complement)`);
      else if (e === "b") {
        out.add("%b balance");
        i += 2;
      } else if (e === "f") out.add("%f frontier");
      else if (/[1-9]/.test(e)) out.add("back reference %1-9");
      else out.add("escaped punctuation");
      continue;
    }
    if (c === "[") {
      out.add(p[i + 1] === "^" ? "set [^...]" : "set [...]");
      let j = i + 1;
      if (p[j] === "^") j++;
      if (p[j] === "]") j++;
      while (j < p.length && p[j] !== "]") {
        if (p[j] === "%") {
          const e = p[j + 1] ?? "";
          if (/[acdglpsuwxACDGLPSUWX]/.test(e))
            out.add(`class %${e}${/[A-Z]/.test(e) ? " (complement)" : ""}`);
          j++;
        } else if (p[j + 1] === "-" && p[j + 2] !== "]") {
          out.add("range a-z in set");
          j += 2;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (c === "(") out.add(p[i + 1] === ")" ? "position capture ()" : "capture (...)");
    else if (c === ".") out.add("any .");
    else if (c === "*") out.add("quantifier *");
    else if (c === "+") out.add("quantifier +");
    else if (c === "-" && i > 0) out.add("quantifier - (lazy)");
    else if (c === "?") out.add("quantifier ?");
    else if (c === "$" && i === p.length - 1) out.add("anchor $");
    // oxlint-disable-next-line no-control-regex
    else if (/[^\x20-\x7e]/.test(c)) out.add("non-printable byte");
  }
}

export function census(modules: string[]): Census {
  const c: Census = {
    modules,
    lib: {},
    stringMethods: {},
    base: {},
    syntax: {},
    bigInts: {},
    metamethods: {},
    formats: new Map(),
    packFormats: new Map(),
    patterns: new Map(),
    patternFeatures: {},
    nonLiteral: {},
    gsubRepl: {},
    plainFind: 0,
    requiresTop: new Map(),
    requiresLazy: new Map(),
    dynamicRequires: 0,
    where: new Map(),
    lines: 0,
    bytes: 0,
    functions: 0,
  };
  const where = (key: string, mod: string) => {
    if (!c.where.has(key)) c.where.set(key, new Set());
    c.where.get(key)!.add(mod);
  };
  for (const mod of modules) {
    const file = moduleFile(mod);
    if (!file) continue;
    const src = readFileSync(file, "utf8");
    c.bytes += Buffer.byteLength(src);
    c.lines += src.split("\n").length;
    const { tokens: toks, longComments } = lex(src);
    bump(c.syntax, "long comment --[[ ]]", longComments);
    c.requiresTop.set(mod, new Set());
    c.requiresLazy.set(mod, new Set());

    // Local functions, aliases of library functions (local fmt = string.format),
    // and locals that shadow a library or base name (local debug = require(...)).
    const localFns = new Set<string>();
    const alias = new Map<string, string>();
    const shadowed = new Set<string>();
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.text === "local") {
        const fnDecl = toks[i + 1]?.text === "function";
        let j = fnDecl ? i + 2 : i + 1;
        const declared: string[] = [];
        while (toks[j]?.kind === "name") {
          declared.push(toks[j]!.text);
          j++;
          if (toks[j]?.text === "<") j += 3; // <const>
          if (toks[j]?.text !== ",") break;
          j++;
        }
        const selfAlias =
          !fnDecl &&
          declared.length === 1 &&
          toks[j]?.text === "=" &&
          toks[j + 1]?.text === declared[0];
        for (const d of declared)
          if ((LIBS.includes(d) || BASE.has(d)) && !selfAlias) {
            shadowed.add(d);
            bump(c.syntax, `local shadowing \`${d}\``);
            where(`local shadowing \`${d}\``, mod);
          }
      }
      if (t.text === "function" && toks[i + 1]?.kind === "name" && toks[i + 2]?.text === "(")
        localFns.add(toks[i + 1]!.text);
      if (t.text === "local" && toks[i + 1]?.kind === "name" && toks[i + 2]?.text === "=") {
        const a = toks[i + 3];
        if (a?.text === "function") localFns.add(toks[i + 1]!.text);
        if (
          a &&
          LIBS.includes(a.text) &&
          toks[i + 4]?.text === "." &&
          toks[i + 5]?.kind === "name"
        ) {
          const after = toks[i + 6];
          if (!after || after.text !== ".")
            alias.set(toks[i + 1]!.text, `${a.text}.${toks[i + 5]!.text}`);
        }
      }
    }

    // Block stack to know whether we are inside a function body.
    const stack: string[] = [];
    let fnDepth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      const prev = toks[i - 1];
      const next = toks[i + 1];
      const afterDot = prev?.kind === "symbol" && (prev.text === "." || prev.text === ":");

      if (t.kind === "keyword") {
        switch (t.text) {
          case "function":
            stack.push("function");
            fnDepth++;
            c.functions++;
            break;
          case "do": // also the body of while/for
            stack.push("do");
            break;
          case "if":
            stack.push("if");
            break;
          case "repeat":
            stack.push("repeat");
            break;
          case "end":
          case "until":
            if (stack.pop() === "function") fnDepth--;
            break;
          case "goto":
            bump(c.syntax, "goto");
            where("goto", mod);
            break;
        }
        continue;
      }

      if (t.kind === "number") {
        const s = t.text.toLowerCase();
        const hex = s.startsWith("0x");
        const isFloat = hex ? /[.p]/.test(s) : /[.e]/.test(s);
        if (isFloat) {
          bump(c.syntax, hex ? "hex float literal" : "float literal");
          bump(c.syntax, `float literal: ${t.text}`);
        } else {
          const v = BigInt(t.text);
          if (v > BIG) {
            bump(c.syntax, hex ? "hex integer literal > 2^53" : "decimal integer literal > 2^53");
            bump(c.bigInts, t.text);
          }
          if (hex) bump(c.syntax, "hex integer literal");
        }
        continue;
      }

      if (t.kind === "string" || t.kind === "longstring") {
        if (t.kind === "longstring") bump(c.syntax, "long string [[ ]]");
        if (t.kind === "string") {
          const body = t.text.slice(1, -1);
          if (/\\x/.test(body)) bump(c.syntax, "string escape \\x");
          if (/\\u\{/.test(body)) bump(c.syntax, "string escape \\u{}");
          if (/\\z/.test(body)) bump(c.syntax, "string escape \\z");
          if (/\\\d/.test(body)) bump(c.syntax, "string escape \\ddd");
        }
        // ("..."):format(...)
        if (next?.text === ")" && toks[i + 2]?.text === ":" && toks[i + 3]?.text === "format")
          c.formats.set(t.value!, (c.formats.get(t.value!) ?? 0) + 1);
        continue;
      }

      if (t.kind === "symbol") {
        switch (t.text) {
          case "&":
          case "|":
          case "<<":
          case ">>":
          case "//":
          case "/":
          case "^":
          case "%":
          case "..":
          case "#":
          case "...":
            bump(c.syntax, t.text === "..." ? "varargs ..." : `operator ${t.text}`);
            if (t.text === "&" || t.text === "|" || t.text === "<<" || t.text === ">>")
              where("bitwise", mod);
            break;
          case "~": {
            const binary =
              prev &&
              (prev.kind === "name" ||
                prev.kind === "number" ||
                prev.kind === "string" ||
                prev.kind === "longstring" ||
                [")", "]", "}", "..."].includes(prev.text) ||
                ["true", "false", "nil"].includes(prev.text));
            bump(c.syntax, binary ? "operator ~ (xor)" : "operator ~ (bnot)");
            where("bitwise", mod);
            break;
          }
          case "::":
            if (toks[i + 2]?.text === "::" && prev?.text !== "::") bump(c.syntax, "label ::name::");
            break;
          case "<":
            if (
              (next?.text === "const" || next?.text === "close") &&
              toks[i + 2]?.text === ">" &&
              prev?.kind === "name"
            ) {
              bump(c.syntax, `<${next.text}>`);
              where(`<${next.text}>`, mod);
            }
            break;
        }
        continue;
      }

      // Names.
      const name = t.text;

      // Metamethod definitions.
      if (name.startsWith("__") && EVENTS.includes(name)) {
        let valueAt: number | undefined;
        if (prev?.text === "." && toks[i - 3]?.text === "function") valueAt = -1; // function X.__index(
        else if (prev?.text === ":" && toks[i - 3]?.text === "function") valueAt = -1;
        else if (
          next?.text === "=" &&
          (afterDot || prev?.text === "{" || prev?.text === "," || prev?.text === ";")
        )
          valueAt = i + 2;
        if (valueAt !== undefined) {
          let kind: string;
          if (valueAt === -1) kind = "function";
          else {
            const v = toks[valueAt]!;
            if (v.text === "function") kind = "function";
            else if (v.text === "{") kind = "table";
            else if (
              v.kind === "name" &&
              skipArg(toks, valueAt) > valueAt + 1 &&
              toks[valueAt + 1]?.text === "."
            )
              kind = "field (X.y)";
            else if (v.kind === "name" && localFns.has(v.text)) kind = "function (named)";
            else if (v.kind === "name" && v.text === "setmetatable") kind = "table (setmetatable)";
            else if (v.kind === "name" && toks[valueAt + 1]?.text === "(") kind = "call result";
            else if (v.kind === "name" && toks[i - 2]?.text === v.text)
              kind = "table (self: X.__index = X)";
            else if (v.kind === "name" || v.kind === "string")
              kind = v.kind === "string" ? `string ${v.text}` : "name";
            else kind = "other";
          }
          bump(c.metamethods, `${name} = ${kind}`);
          bump(c.metamethods, name);
          where(name, mod);
        }
        continue;
      }

      // Library references: string.format, table.concat, ...
      if (shadowed.has(name)) continue;
      if (LIBS.includes(name) && !afterDot && next?.text === "." && toks[i + 2]?.kind === "name") {
        const fn = toks[i + 2]!.text;
        const key = `${name}.${fn}`;
        bump(c.lib, key);
        if (["os", "io", "debug", "coroutine", "package"].includes(name)) where(key, mod);
        if (name === "string") analyzeStringCall(c, toks, i + 3, fn, false, mod);
        i += 2;
        continue;
      }
      if (alias.has(name) && !afterDot && next?.text === "(") {
        const key = alias.get(name)!;
        if (key.startsWith("string.")) analyzeStringCall(c, toks, i + 1, key.slice(7), false, mod);
        continue;
      }
      // Method calls that look like string methods: s:sub(...), s:byte(...).
      if (
        prev?.text === ":" &&
        toks[i - 2]?.text !== "self" &&
        STRING_FNS.has(name) &&
        (next?.text === "(" || next?.kind === "string")
      ) {
        bump(c.stringMethods, name);
        analyzeStringCall(c, toks, i + 1, name, true, mod);
        continue;
      }
      if (BASE.has(name) && !afterDot) {
        const isLocalDecl = prev?.text === "local" || prev?.text === "function";
        if (!isLocalDecl) {
          bump(c.base, name);
          if (["load", "loadfile", "dofile", "collectgarbage", "print", "warn"].includes(name))
            where(name, mod);
        }
        if (name === "require") {
          let lit: string | undefined;
          if (next?.text === "(") lit = literalArg(toks, i + 2);
          else if (next?.kind === "string") lit = next.value;
          if (lit === undefined) c.dynamicRequires++;
          else (fnDepth > 0 ? c.requiresLazy : c.requiresTop).get(mod)!.add(lit);
        }
      }
    }
  }
  for (const [p, uses] of c.patterns) {
    const fs = new Set<string>();
    patternFeatures(p, fs);
    const n = uses.reduce((a, u) => a + u.count, 0);
    for (const f of fs) bump(c.patternFeatures, f, n);
  }
  return c;
}

function analyzeStringCall(
  c: Census,
  toks: Token[],
  open: number,
  fn: string,
  method: boolean,
  mod: string,
) {
  const t = toks[open];
  // f"literal" call syntax: s:find"x"
  if (t?.kind === "string") {
    if (method && PATTERN_FNS.has(fn)) addPattern(c, t.value!, fn);
    return;
  }
  if (t?.text !== "(") return;
  const a = args(toks, open);
  const first = method ? 0 : 1; // index of the pattern / format argument
  if (fn === "format") {
    const at = method ? undefined : a[0];
    if (at === undefined) return; // s:format(...) receiver is the format; handled for ("..."):format
    const lit = literalArg(toks, at);
    if (lit === undefined) bump(c.nonLiteral, "string.format format");
    else c.formats.set(lit, (c.formats.get(lit) ?? 0) + 1);
    return;
  }
  if (fn === "pack" || fn === "unpack" || fn === "packsize") {
    if (method) return;
    const at = a[0];
    const lit = at === undefined ? undefined : literalArg(toks, at);
    if (lit === undefined) bump(c.nonLiteral, `string.${fn} format`);
    else {
      if (!c.packFormats.has(lit)) c.packFormats.set(lit, {});
      bump(c.packFormats.get(lit)!, fn);
    }
    return;
  }
  if (PATTERN_FNS.has(fn)) {
    const at = a[first];
    const lit = at === undefined ? undefined : literalArg(toks, at);
    if (fn === "find") {
      const plainAt = a[first + 2];
      if (plainAt !== undefined && toks[plainAt]!.text === "true") {
        c.plainFind++;
        return;
      }
    }
    if (fn === "gsub") bump(c.gsubRepl, argKind(toks, a[first + 1]));
    if (lit === undefined) {
      bump(c.nonLiteral, `${fn} pattern`);
      if (!c.where.has(`non-literal ${fn}`)) c.where.set(`non-literal ${fn}`, new Set());
      c.where.get(`non-literal ${fn}`)!.add(mod);
    } else addPattern(c, lit, fn);
  }
}

function addPattern(c: Census, p: string, fn: string) {
  if (!c.patterns.has(p)) c.patterns.set(p, []);
  const uses = c.patterns.get(p)!;
  const u = uses.find((x) => x.fn === fn);
  if (u) u.count++;
  else uses.push({ fn, count: 1 });
}

// ---- report

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

const list = (s: Set<string> | undefined, max = 8) => {
  const xs = [...(s ?? [])].sort();
  return xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")}, ... (${xs.length})`;
};

async function main() {
  console.log("collecting package.loaded over all inputs...");
  const loaded = await loadedModules();
  const union = new Set([...loaded.mini, ...loaded.es5]);
  // Lazy requires: modules required inside function bodies of loaded modules, not loaded themselves.
  const first = census([...union].sort());
  const lazy = new Map<string, Set<string>>();
  for (const [mod, reqs] of first.requiresLazy)
    for (const r of reqs)
      if (!union.has(r)) {
        if (!lazy.has(r)) lazy.set(r, new Set());
        lazy.get(r)!.add(mod);
      }
  const set = [...union, ...lazy.keys()].filter((m) => moduleFile(m)).sort();
  const c = census(set);
  const lazyFiles = [...lazy.keys()].filter((m) => moduleFile(m));

  const out: string[] = [];
  out.push(`<!-- Generated by scripts/census.ts (vp run census). Do not edit. -->

# Census of tslua's check path

Static counts over the Lua modules that checking the oracle inputs actually
loads, plus the modules those modules \`require\` lazily (inside a function)
that no input loaded. Token-level analysis (\`scripts/lualex.ts\`): comments and
strings are skipped, but nothing is resolved, so a local that shadows
\`string\` or \`pairs\` would be miscounted (none was seen), and \`x:sub(...)\`
style calls are counted as string methods by name.

## Modules

| | modules | lines | bytes | functions |
|---|---|---|---|---|
| loaded, mini | ${loaded.mini.size} | | | |
| loaded, es5 | ${loaded.es5.size} | | | |
| loaded, union | ${union.size} | ${n(first.lines)} | ${n(first.bytes)} | ${n(first.functions)} |
| + lazy, not loaded | ${lazyFiles.length} | | | |
| counted below | ${set.length} | ${n(c.lines)} | ${n(c.bytes)} | ${n(c.functions)} |

Only in mini: ${list(new Set([...loaded.mini].filter((m) => !loaded.es5.has(m))), 20) || "none"}.
Only in es5: ${list(new Set([...loaded.es5].filter((m) => !loaded.mini.has(m))), 20) || "none"}.
Dynamic (non-literal) \`require\` calls in the set: ${c.dynamicRequires}.

### Loaded modules (union), by package

${table(
  ["package", "modules"],
  [...groupBy([...union].sort(), (m) => m.split(".").slice(0, 2).join(".")).entries()].map(
    ([pkg, ms]) => [
      `${pkg} (${ms.length})`,
      ms.map((m) => m.slice(pkg.length + 1) || "(init)").join(", "),
    ],
  ),
)}

### Lazily required, never loaded by an input

${table(
  ["module", "required from"],
  [...lazy.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([m, from]) => [m + (moduleFile(m) ? "" : " (no file)"), list(from, 4)]),
)}
`);

  const libRows = sorted(c.lib).map(([k, n]) => [code(k), n, list(c.where.get(k), 3)]);
  out.push(`## Library functions referenced

\`lib.fn\` references (including \`local f = string.format\` aliases, counted
once). Where it matters, the modules that reference them.

${table(["function", "refs", "in (os/io/debug/coroutine/package only)"], libRows)}

### Method calls with string-library names (\`s:sub(...)\`)

${table(
  ["method", "calls"],
  sorted(c.stringMethods).map(([k, n]) => [code(k), n]),
)}

### Base functions

${table(
  ["function", "refs", "in"],
  sorted(c.base).map(([k, n]) => [code(k), n, list(c.where.get(k), 4)]),
)}
`);

  const floats = sorted(c.syntax).filter(([k]) => k.startsWith("float literal: "));
  out.push(`## Syntax

${table(
  ["feature", "count", "in"],
  sorted(c.syntax)
    .filter(([k]) => !k.startsWith("float literal: "))
    .map(([k, n]) => [
      esc(k),
      n,
      k === "goto" || k.startsWith("<") || k.startsWith("local shadowing")
        ? list(c.where.get(k), 6)
        : "",
    ]),
)}

Modules with bitwise operators: ${c.where.get("bitwise")?.size ?? 0}.

Distinct float literals (${floats.length}): ${floats.map(([k, n]) => `\`${k.slice(15)}\`×${n}`).join(", ") || "none"}.

Integer literals above 2^53: ${
    sorted(c.bigInts)
      .map(([k, n]) => `\`${k}\`×${n}`)
      .join(", ") || "none"
  }.
`);

  out.push(`## Metamethods defined

Definitions (\`mt.__index = ...\`, \`{ __index = ... }\`, \`function mt.__index(...)\`)
by the kind of value: a function literal, a named local function, a table
constructor, the table itself (\`X.__index = X\`), or some other name.

${table(
  ["metamethod", "definitions", "in"],
  sorted(c.metamethods)
    .filter(([k]) => !k.includes(" = "))
    .map(([k, n]) => [code(k), n, list(c.where.get(k), 4)]),
)}

${table(
  ["definition", "count"],
  sorted(c.metamethods)
    .filter(([k]) => k.includes(" = "))
    .map(([k, n]) => [esc(k), n]),
)}
`);

  const formats = [...c.formats.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const specs: Counter = {};
  for (const [f, n] of formats)
    for (const m of f.matchAll(/%[-+ #0]*\d*(?:\.\d+)?[a-zA-Z%]/g)) bump(specs, m[0], n);
  out.push(`## string.format

${formats.length} distinct literal format strings, ${c.nonLiteral["string.format format"] ?? 0} calls with a non-literal format.

Conversion specs used (weighted by calls): ${sorted(specs)
    .map(([k, n]) => `\`${k}\`×${n}`)
    .join(", ")}.

${table(
  ["format", "calls"],
  formats.map(([f, n]) => [code(f), n]),
)}
`);

  out.push(`## string.pack / unpack / packsize

${table(
  ["format", "calls"],
  [...c.packFormats.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([f, n]) => [
      code(f),
      sorted(n)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
    ]),
)}

Non-literal formats: ${["pack", "unpack", "packsize"].map((f) => `${f} ${c.nonLiteral[`string.${f} format`] ?? 0}`).join(", ")}.
`);

  const pats = [...c.patterns.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  out.push(`## Patterns (find, match, gmatch, gsub)

${pats.length} distinct literal patterns. Plain \`find(s, p, init, true)\` calls (no
pattern): ${c.plainFind}. Non-literal patterns: ${["find", "match", "gmatch", "gsub"]
    .map((f) => `${f} ${c.nonLiteral[`${f} pattern`] ?? 0}`)
    .join(", ")} (in ${list(
    new Set(
      ["find", "match", "gmatch", "gsub"].flatMap((f) => [
        ...(c.where.get(`non-literal ${f}`) ?? []),
      ]),
    ),
    6,
  )}).
\`gsub\` replacement argument: ${sorted(c.gsubRepl)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ")}.

Pattern features (calls whose literal pattern uses the feature):

${table(
  ["feature", "calls"],
  sorted(c.patternFeatures).map(([k, n]) => [esc(k), n]),
)}

${table(
  ["pattern", "uses"],
  pats.map(([p, uses]) => [code(p), uses.map((u) => `${u.fn} ${u.count}`).join(", ")]),
)}
`);

  writeFileSync(join(root, "docs/CENSUS.md"), out.join("\n"));
  console.log(`wrote docs/CENSUS.md (${set.length} modules)`);
}

if (import.meta.main) await main();
