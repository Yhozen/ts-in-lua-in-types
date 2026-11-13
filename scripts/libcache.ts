// Does reusing the parsed (and bound) lib across checks change any output,
// and what does a check cost with a warm cache? Under real Lua (wasmoon).
//
//   vp run libcache   -> oracle/libcache.json
//
// For every input in both lib modes, a fresh state loads tslua, turns on
// the lib cache (lua/sourcecache.lua: the compiler host hands back the
// SourceFile parsed by an earlier check when its text is unchanged), runs a
// warm-up check of an empty main.ts (which parses and binds the lib), then
// checks the input under the count hook: the lib comes from the cache. The
// output must equal the oracle's (no cache, fresh state). `chain` also checks
// every input in sequence in one state per lib mode (each check reusing the
// lib the previous ones used) and compares every output.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LuaFactory } from "wasmoon";
import { expectedPath, inputPath, listInputs } from "./oracle.ts";
import { runPool, type Job } from "./pool.ts";
import { argsFor, createFactory, libs, LUA_PATH, root, type Lib } from "./tslua.ts";

const luaArgs = (lib: Lib) =>
  `{ ${argsFor(lib)
    .map((a) => JSON.stringify(a))
    .join(", ")} }`;

export const warmup = (lib: Lib) => `
require("sourcecache").enable()
local files = { ["/p/main.ts"] = "", ["/p/${lib.file}"] = [=====[${readFileSync(lib.path, "utf8")}]=====] }
__WARM_OUT = __TSC.check(files, ${luaArgs(lib)})`;

/** Every input in sequence in one Lua state with the cache on; the outputs that differ from the oracle. */
async function chain(lib: Lib, names: string[]): Promise<string[]> {
  const factory: LuaFactory = await createFactory();
  const lua = await factory.createEngine();
  try {
    await lua.doString(
      `package.path = "${LUA_PATH}"; __TSC = require("tsc"); require("sourcecache").enable()`,
    );
    lua.global.set("__LIB", readFileSync(lib.path, "utf8"));
    names.forEach((name, i) =>
      lua.global.set(`__MAIN_${i + 1}`, readFileSync(inputPath(name), "utf8")),
    );
    // One Lua loop: a doString per check crashes wasmoon after a few dozen
    // checks. wasmoon cuts strings at a NUL byte, hence the separator.
    const outs = (await lua.doString(`
      local outs = {}
      for i = 1, ${names.length} do
        outs[i] = (__TSC.check({ ["/p/main.ts"] = _G["__MAIN_" .. i], ["/p/${lib.file}"] = __LIB }, ${luaArgs(lib)}))
      end
      return table.concat(outs, "\\1\\2\\1")`)) as string;
    const list = outs.split("\x01\x02\x01");
    return names.filter(
      (name, i) => list[i] !== readFileSync(expectedPath(name, lib.name), "utf8"),
    );
  } finally {
    lua.global.close();
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(root, "oracle/manifest.json"), "utf8")) as {
    entries: { input: string; lib: string; instructions: number }[];
  };
  const cold = new Map(manifest.entries.map((e) => [`${e.input}.${e.lib}`, e.instructions]));
  const names = listInputs();
  const plan = (["mini", "es5"] as const).flatMap((lib) => names.map((name) => ({ name, lib })));
  const preludes = { mini: warmup(libs.mini), es5: warmup(libs.es5) };
  const jobs: Job[] = plan.map(({ name, lib }, id) => ({
    id,
    source: readFileSync(inputPath(name), "utf8"),
    lib,
    options: { count: true, prelude: preludes[lib], epilogue: "return __WARM_OUT" },
  }));
  console.log(`${jobs.length} checks with a warm lib cache...`);
  const results = await runPool(jobs, (_r, done) => {
    if (done % 100 === 0) console.log(`  ${done}/${jobs.length}`);
  });
  const rows = results.map((r) => {
    const { name, lib } = plan[r.id]!;
    const c = cold.get(`${name}.${lib}`)!;
    return {
      input: name,
      lib,
      sameOutput: r.result.output === readFileSync(expectedPath(name, lib), "utf8"),
      warmupOutputEmpty: r.result.extra === "",
      cold: c,
      cached: r.result.instructions!,
    };
  });
  console.log("chains (every input in one state)...");
  const chains = {
    mini: await chain(libs.mini, names),
    es5: await chain(libs.es5, names),
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const summary = Object.fromEntries(
    (["mini", "es5"] as const).map((lib) => {
      const xs = rows.filter((x) => x.lib === lib);
      const one = xs.find((x) => x.input === "assign-basic")!;
      return [
        lib,
        {
          inputs: xs.length,
          outputsChanged: xs.filter((x) => !x.sameOutput).map((x) => x.input),
          chainOutputsChanged: chains[lib],
          oneLiner: { cold: one.cold, cached: one.cached },
          coldMedian: median(xs.map((x) => x.cold)),
          cachedMedian: median(xs.map((x) => x.cached)),
          cachedMin: Math.min(...xs.map((x) => x.cached)),
          cachedMax: Math.max(...xs.map((x) => x.cached)),
        },
      ];
    }),
  );
  writeFileSync(
    join(root, "oracle/libcache.json"),
    JSON.stringify(
      {
        generated: "by scripts/libcache.ts (vp run libcache); do not edit",
        counting:
          "cached = real Lua instructions of tsc.check after require('sourcecache').enable() and a warm-up check of an empty main.ts in the same state; cold = oracle/manifest.json (fresh state, no cache)",
        summary,
        rows,
      },
      null,
      1,
    ) + "\n",
  );
  console.log(JSON.stringify(summary, null, 1));
  if (
    Object.values(summary).some((s) => s.outputsChanged.length + s.chainOutputsChanged.length > 0)
  )
    process.exitCode = 1;
}

if (import.meta.main) await main();
