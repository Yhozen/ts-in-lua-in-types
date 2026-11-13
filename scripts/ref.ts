// The P1 gate: tslua on the lua-in-types v2 reference interpreter must print
// exactly what it prints under real Lua (oracle/expected/), byte for byte, on
// every input in both lib modes.
//
//   vp run ref                    every input, fresh state per check -> oracle/ref-manifest.json
//   vp run ref -- --image         the same, each check restored from image/boot.<lib>.json
//                                 (vp run boot) -> oracle/ref-image-manifest.json
//   vp run ref -- --only NAME     only inputs whose name contains NAME (no manifest)
//   vp run ref -- --lib mini      one lib mode (no manifest)
//   vp run ref -- --modules       rewrite oracle/modules.json first (package.loaded
//                                 after every input under real Lua)
//
// The manifest holds the reference's counters per check (scripts/luaref.ts
// defines the program and the per-check chunk) next to real Lua's exact
// instruction counts from oracle/manifest.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Counters } from "../vendor/lua-in-types/src/aot/ref/interp.ts";
import { loadedModules } from "./census.ts";
import { loadedInterp, modulesPath, refProgram } from "./luaref.ts";
import { expectedPath, inputPath, listInputs } from "./oracle.ts";
import type { RefJob, RefReply } from "./ref-worker.ts";
import { libs, root, type Lib } from "./tslua.ts";

interface OracleEntry {
  input: string;
  lib: Lib["name"];
  instructions: number;
  status: number;
}

const quantiles = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!;
  return { n: s.length, min: s[0]!, median: q(0.5), p90: q(0.9), max: s[s.length - 1]! };
};

/** The counters a manifest keeps per check. */
export const counterRow = (c: Counters) => ({
  ops: c.ops,
  blocks: c.blocks,
  luaCalls: c.luaCalls,
  tableWrites: c.tableWrites,
  tables: c.tables,
  closures: c.closures,
  cells: c.cells,
  maxDepth: c.maxDepth,
  builtinCalls: Object.fromEntries(Object.entries(c.builtinCalls).sort((a, b) => b[1] - a[1])),
  metamethods: Object.fromEntries(Object.entries(c.metamethods).sort((a, b) => b[1] - a[1])),
});

export async function runRefPool(
  jobs: RefJob[],
  onDone: (r: RefReply, done: number) => void,
  size = Math.max(1, Math.min(jobs.length, availableParallelism() - 2, 12)),
): Promise<RefReply[]> {
  const results: RefReply[] = Array.from({ length: jobs.length });
  let next = 0;
  let done = 0;
  const url = new URL("./ref-worker.ts", import.meta.url);
  await Promise.all(
    Array.from({ length: size }, async () => {
      const worker = new Worker(url, { resourceLimits: { maxOldGenerationSizeMb: 8192 } });
      try {
        while (next < jobs.length) {
          const job = jobs[next++]!;
          const r = await new Promise<RefReply>((resolve, reject) => {
            worker.once("message", (m: RefReply) => {
              worker.off("error", reject);
              resolve(m);
            });
            worker.once("error", reject);
            worker.postMessage(job);
          });
          results[job.id] = r;
          onDone(r, ++done);
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  return results;
}

async function writeModules() {
  console.log("collecting package.loaded under real Lua...");
  const loaded = await loadedModules();
  const modules = [...new Set([...loaded.mini, ...loaded.es5])].sort();
  writeFileSync(
    modulesPath,
    JSON.stringify(
      {
        generated:
          "by scripts/ref.ts (vp run ref -- --modules): every module in package.loaded after checking each input under real Lua, both lib modes; do not edit",
        modules,
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`wrote oracle/modules.json (${modules.length} modules)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const image = argv.includes("--image");
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]! : undefined;
  const libNames = (
    argv.includes("--lib") ? [argv[argv.indexOf("--lib") + 1]!] : ["mini", "es5"]
  ) as Lib["name"][];
  const partial = only !== undefined || libNames.length !== 2;
  if (argv.includes("--modules")) await writeModules();

  const oracle = JSON.parse(readFileSync(join(root, "oracle/manifest.json"), "utf8")) as {
    entries: OracleEntry[];
  };
  const real = new Map(oracle.entries.map((e) => [`${e.input}.${e.lib}`, e]));
  // Real Lua with the lib cache warm (vp run libcache): the state the image holds.
  const cachedPath = join(root, "oracle/libcache.json");
  const cached = existsSync(cachedPath)
    ? new Map(
        (
          JSON.parse(readFileSync(cachedPath, "utf8")) as {
            rows: { input: string; lib: string; cached: number }[];
          }
        ).rows.map((e) => [`${e.input}.${e.lib}`, e.cached]),
      )
    : new Map<string, number>();
  const names = listInputs().filter((n) => only === undefined || n.includes(only));
  const jobs: RefJob[] = [];
  const meta: { name: string; lib: Lib["name"] }[] = [];
  // The slow extremes first, so they do not end up alone at the end.
  const order = [...names].sort(
    (a, b) => Number(b.startsWith("extreme/")) - Number(a.startsWith("extreme/")),
  );
  for (const lib of libNames.slice().reverse())
    for (const name of order) {
      meta.push({ name, lib });
      jobs.push({ id: jobs.length, source: readFileSync(inputPath(name), "utf8"), lib, image });
    }
  console.log(
    `${names.length} inputs x ${libNames.join(",")} = ${jobs.length} checks on the reference${image ? " (from the boot image)" : ""}`,
  );
  const t0 = performance.now();
  const results = await runRefPool(jobs, (_r, done) => {
    if (done % 50 === 0 || done === jobs.length)
      console.log(`  ${done}/${jobs.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  });

  const pass: Record<string, number> = {};
  const fail: string[] = [];
  for (const r of results) {
    const { name, lib } = meta[r.id]!;
    const expected = readFileSync(expectedPath(name, lib));
    const same =
      Buffer.from(r.check.output, "latin1").equals(expected) &&
      r.check.status === real.get(`${name}.${lib}`)?.status;
    if (same) pass[lib] = (pass[lib] ?? 0) + 1;
    else fail.push(`${name}.${lib}`);
  }
  for (const lib of libNames) console.log(`${lib}: ${pass[lib] ?? 0}/${names.length} match`);
  for (const f of fail) console.log(`  MISMATCH ${f}`);
  process.exitCode = fail.length === 0 ? 0 : 1;
  if (partial || fail.length > 0) return;

  const program = refProgram();
  const load = loadedInterp(program, libs.mini).load.counters;
  const entries = results.map((r) => {
    const { name, lib } = meta[r.id]!;
    return {
      input: name,
      lib,
      instructions: real.get(`${name}.${lib}`)!.instructions,
      ...(image ? { instructionsCached: cached.get(`${name}.${lib}`) } : {}),
      ...counterRow(r.check.counters),
      ms: Math.round(r.check.ms),
      setupMs: Math.round(r.setupMs),
    };
  });
  entries.sort((a, b) =>
    a.lib !== b.lib ? (a.lib === "mini" ? -1 : 1) : a.input < b.input ? -1 : 1,
  );
  const summary = Object.fromEntries(
    libNames.map((lib) => {
      const es = entries.filter((e) => e.lib === lib);
      const ratio = es.map((e) => e.ops / e.instructions);
      return [
        lib,
        {
          pass: pass[lib] ?? 0,
          ops: quantiles(es.map((e) => e.ops)),
          blocks: quantiles(es.map((e) => e.blocks)),
          luaCalls: quantiles(es.map((e) => e.luaCalls)),
          tableWrites: quantiles(es.map((e) => e.tableWrites)),
          tables: quantiles(es.map((e) => e.tables)),
          instructions: quantiles(es.map((e) => e.instructions)),
          ...(image
            ? { instructionsCached: quantiles(es.map((e) => e.instructionsCached ?? 0)) }
            : {}),
          opsPerInstruction: quantiles(ratio.map((x) => Math.round(x * 1000) / 1000)),
          ms: quantiles(es.map((e) => e.ms)),
        },
      ];
    }),
  );
  const manifest = {
    generated: `by scripts/ref.ts (vp run ref${image ? " -- --image" : ""}); do not edit`,
    interpreter:
      "lua-in-types v2 reference (vendor/lua-in-types/src/aot/ref), see scripts/luaref.ts",
    mode: image
      ? "each check restored from image/boot.<lib>.json (vp run boot): =boot, =cache and a warm-up check already ran (the lib is parsed and bound)"
      : "each check in a fresh state: =boot (require 'tsc', counted under load), then =check",
    counting: `counters of the =check chunk only (Interp counters: ops = IR ops and terminators, blocks = blocks entered, luaCalls = Lua frames pushed, tableWrites = raw writes, tables/closures/cells = allocations, maxDepth = Lua frames); instructions = real Lua 5.4 VM instructions of tsc.check from oracle/manifest.json (fresh state, no warm-up)${image ? "; instructionsCached = the same after the lib cache (lua/sourcecache.lua) and a warm-up check (oracle/libcache.json), the state the image holds" : ""}`,
    ...(image ? {} : { load: counterRow(load) }),
    summary,
    entries,
  };
  const out = join(root, image ? "oracle/ref-image-manifest.json" : "oracle/ref-manifest.json");
  writeFileSync(out, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`wrote ${out.slice(root.length + 1)}`);
}

if (import.meta.main) await main();
