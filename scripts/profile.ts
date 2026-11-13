// The dynamic profile of tslua's check path -> docs/PROFILE.md and
// oracle/profile.json.
//
//   vp run profile
//
// Every input in mini mode, and every 8th input plus the extremes in es5 mode, runs with the
// instrumentation of scripts/profile.lua: library and base functions wrapped
// (before tslua loads, so its local aliases capture the wrappers), a call/
// return hook for call depth and metamethod invocations, and pcall/xpcall
// wrappers that count failures. Counting covers tsc.check only, not loading.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedPath, inputPath, listInputs } from "./oracle.ts";
import { code, esc, n, sorted, table } from "./md.ts";
import { runPool, type Job } from "./pool.ts";
import { root, type Lib } from "./tslua.ts";

const preload = readFileSync(join(root, "scripts/profile.lua"), "utf8");

interface RunProfile {
  calls: Record<string, number>;
  strArgs: Record<string, [number, number, number]>;
  patterns: Record<string, number>;
  formats: Record<string, number>;
  packFormats: Record<string, number>;
  gsubRepl: Record<string, number>;
  plainFind: number;
  metamethods: Record<string, number>;
  metatableFields: Record<string, number>;
  pcallFailed: number;
  maxDepth: number;
  maxLuaDepth: number;
  floatsFormatted: number;
  floatsFromTonumber: number;
  lazyRequires: Record<string, number>;
  touched: Record<string, string>;
}

interface Aggregate {
  runs: number;
  /** Sum over runs. */
  calls: Record<string, number>;
  /** Runs in which the function was called at all. */
  callRuns: Record<string, number>;
  strArgs: Record<string, { calls: number; avgLen: number; maxLen: number }>;
  patterns: Record<string, number>;
  formats: Record<string, number>;
  packFormats: Record<string, number>;
  gsubRepl: Record<string, number>;
  plainFind: number;
  metamethods: Record<string, number>;
  metatableFields: Record<string, number>;
  pcallFailed: number;
  maxDepth: { max: number; input: string };
  maxLuaDepth: { max: number; input: string };
  floatsFormatted: number;
  floatsFromTonumber: number;
  lazyRequires: Record<string, number>;
  touched: Record<string, string[]>;
  perturbed: string[];
}

const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

function aggregate(runs: { input: string; p: RunProfile; same: boolean }[]): Aggregate {
  const a: Aggregate = {
    runs: runs.length,
    calls: {},
    callRuns: {},
    strArgs: {},
    patterns: {},
    formats: {},
    packFormats: {},
    gsubRepl: {},
    plainFind: 0,
    metamethods: {},
    metatableFields: {},
    pcallFailed: 0,
    maxDepth: { max: 0, input: "" },
    maxLuaDepth: { max: 0, input: "" },
    floatsFormatted: 0,
    floatsFromTonumber: 0,
    lazyRequires: {},
    touched: {},
    perturbed: [],
  };
  const sums: Record<string, [number, number, number]> = {};
  for (const { input, p, same } of runs) {
    if (!same) a.perturbed.push(input);
    add(a.calls, p.calls);
    for (const k of Object.keys(p.calls)) a.callRuns[k] = (a.callRuns[k] ?? 0) + 1;
    for (const [k, [n, total, max]] of Object.entries(p.strArgs)) {
      const s = (sums[k] ??= [0, 0, 0]);
      s[0] += n;
      s[1] += total;
      s[2] = Math.max(s[2], max);
    }
    add(a.patterns, p.patterns);
    add(a.formats, p.formats);
    add(a.packFormats, p.packFormats);
    add(a.gsubRepl, p.gsubRepl);
    add(a.metamethods, p.metamethods);
    add(a.metatableFields, p.metatableFields);
    add(a.lazyRequires, p.lazyRequires);
    a.plainFind += p.plainFind;
    a.pcallFailed += p.pcallFailed;
    a.floatsFormatted += p.floatsFormatted;
    a.floatsFromTonumber += p.floatsFromTonumber;
    if (p.maxDepth > a.maxDepth.max) a.maxDepth = { max: p.maxDepth, input };
    if (p.maxLuaDepth > a.maxLuaDepth.max) a.maxLuaDepth = { max: p.maxLuaDepth, input };
    for (const [k, where] of Object.entries(p.touched)) {
      const list = (a.touched[k] ??= []);
      if (!list.includes(where)) list.push(where);
    }
  }
  for (const [k, [n, total, max]] of Object.entries(sums))
    a.strArgs[k] = { calls: n, avgLen: Math.round((total / n) * 10) / 10, maxLen: max };
  return a;
}

// ---- report

const per = (x: number, runs: number) => n(Math.round((x / runs) * 10) / 10);

function section(lib: string, a: Aggregate): string {
  const out: string[] = [];
  const split = (k: string) => k.split("\0") as [string, string];
  out.push(`## ${lib} mode (${a.runs} inputs)

Output identical to the oracle with the instrumentation on: ${a.perturbed.length === 0 ? "yes, for every input" : `no: ${a.perturbed.join(", ")}`}.

Max call depth (all frames, below the harness chunk): ${a.maxDepth.max} (${a.maxDepth.input}).
Max Lua call depth: ${a.maxLuaDepth.max} (${a.maxLuaDepth.input}).
\`pcall\`/\`xpcall\` calls: ${n((a.calls.pcall ?? 0) + (a.calls.xpcall ?? 0))}, of which failed (caught an error): ${n(a.pcallFailed)}; \`error\` calls: ${n(a.calls.error ?? 0)}.
\`setmetatable\` calls: ${n(a.calls.setmetatable ?? 0)} (${per(a.calls.setmetatable ?? 0, a.runs)} per input).
\`pairs\`: ${n(a.calls.pairs ?? 0)}, \`next\`: ${n(a.calls.next ?? 0)}, \`ipairs\`: ${n(a.calls.ipairs ?? 0)}.
Floats: ${n(a.floatsFormatted)} float arguments to \`tostring\`/\`string.format\`; ${n(a.floatsFromTonumber)} \`tonumber\` results that are floats.
Modules required during the check (not at load): ${
    sorted(a.lazyRequires)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ") || "none"
  }.

### os, io, debug, coroutine, load, collectgarbage, print on the check path

${
  Object.keys(a.touched).length === 0
    ? "None."
    : table(
        ["function", "calls", "first call sites"],
        Object.entries(a.touched)
          .sort((x, y) => (x[0] < y[0] ? -1 : 1))
          .map(([k, where]) => [
            code(k),
            n(a.calls[k] ?? 0),
            where.slice(0, 4).map(esc).join(", "),
          ]),
      )
}

### Library and base function calls

${table(
  ["function", "calls", "per input", "inputs calling it", "1st arg (string): avg len", "max len"],
  sorted(a.calls).map(([k, v]) => [
    code(k),
    n(v),
    per(v, a.runs),
    a.callRuns[k] ?? 0,
    a.strArgs[k] ? a.strArgs[k]!.avgLen : "",
    a.strArgs[k] ? n(a.strArgs[k]!.maxLen) : "",
  ]),
)}

(For \`string.char\` the length columns are argument counts.)

### Metamethod invocations

Calls of metamethod handlers that are functions, by event and handler kind
(Lua function or C function), from a call hook: \`namewhat == "metamethod"\`
for calls made by the VM; "(from C)" for handlers called by a C function such
as \`tostring\`; \`__call\` handlers by identity. \`__index\`/\`__newindex\`
handlers that are tables are not calls and do not appear here (see the
metatable field kinds below).

${
  Object.keys(a.metamethods).length === 0
    ? "None."
    : table(
        ["event / handler", "calls"],
        sorted(a.metamethods).map(([k, v]) => [esc(k), n(v)]),
      )
}

Metatable fields per \`setmetatable\` call during the check (field and value type):

${table(
  ["field", "count"],
  sorted(a.metatableFields).map(([k, v]) => [esc(k), n(v)]),
)}

### Patterns executed

Plain \`find\` calls: ${n(a.plainFind)}. \`gsub\` replacements: ${
    sorted(a.gsubRepl)
      .map(([k, v]) => `${k} ${n(v)}`)
      .join(", ") || "none"
  }.

${table(
  ["function", "pattern", "calls"],
  sorted(a.patterns).map(([k, v]) => {
    const [fn, p] = split(k);
    return [fn, code(p), n(v)];
  }),
)}

### string.format formats executed

${table(
  ["format", "calls"],
  sorted(a.formats).map(([k, v]) => [code(k), n(v)]),
)}

### string.pack / unpack formats executed

${
  Object.keys(a.packFormats).length === 0
    ? "None."
    : table(
        ["function", "format", "calls"],
        sorted(a.packFormats).map(([k, v]) => {
          const [fn, f] = split(k);
          return [fn, code(f), n(v)];
        }),
      )
}
`);
  return out.join("\n");
}

async function main() {
  const names = listInputs();
  const plan: { name: string; lib: Lib["name"] }[] = [
    ...names.map((name) => ({ name, lib: "mini" as const })),
    ...names
      .filter((name, i) => i % 8 === 0 || name.startsWith("extreme/"))
      .map((name) => ({ name, lib: "es5" as const })),
  ];
  const jobs: Job[] = plan.map(({ name, lib }, id) => ({
    id,
    source: readFileSync(inputPath(name), "utf8"),
    lib,
    options: { preload, epilogue: "return __PROFILE_JSON()" },
  }));
  console.log(`${jobs.length} profiled checks`);
  const t0 = performance.now();
  const results = await runPool(jobs, (_, done) => {
    if (done % 50 === 0)
      console.log(`  ${done}/${jobs.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  });
  const byLib: Record<string, { input: string; p: RunProfile; same: boolean }[]> = {
    mini: [],
    es5: [],
  };
  for (const r of results) {
    const { name, lib } = plan[r.id]!;
    const same = r.result.output === readFileSync(expectedPath(name, lib), "utf8");
    byLib[lib]!.push({ input: name, p: JSON.parse(r.result.extra!) as RunProfile, same });
  }
  const mini = aggregate(byLib.mini!);
  const es5 = aggregate(byLib.es5!);
  writeFileSync(
    join(root, "oracle/profile.json"),
    JSON.stringify(
      { generated: "by scripts/profile.ts (vp run profile); do not edit", mini, es5 },
      null,
      1,
    ) + "\n",
  );
  const md = `<!-- Generated by scripts/profile.ts (vp run profile). Do not edit. -->

# Dynamic profile of tslua's check path

What \`tsc.check\` actually does at run time (loading excluded), under real
Lua 5.4 (wasmoon), over the oracle inputs: every input in mini mode, every
8th input and the extremes (${es5.runs}) in es5 mode. Instrumentation: \`scripts/profile.lua\`.
Raw numbers: \`oracle/profile.json\`.

${section("mini", mini)}
${section("es5", es5)}`;
  writeFileSync(join(root, "docs/PROFILE.md"), md);
  console.log(`wrote docs/PROFILE.md and oracle/profile.json`);
}

await main();
