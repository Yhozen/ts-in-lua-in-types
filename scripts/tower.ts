// The tower measurement: tslua (under wasmoon) type-checks the type-level
// Lua engine of lua-in-types v1 (vendor/lua-in-types/src/engine/*.ts).
//
//   vp run tower    -> oracle/tower.json (takes a while: int.ts alone is
//                      ~75 s per run, the whole engine much longer)
//
// Lib: lib.es5.d.ts as a root file with --noLib (tsrs accepts the engine with
// exactly these options and no diagnostics). Every run is in a fresh wasm
// instance; see main() for which hooks each run uses.
//
// Result (2026-11-13): int.ts alone checks clean (as in tsrs) in ~8.8G VM
// instructions; the whole engine runs out of wasm32 memory (2 GB) after ~21G
// instructions (Lua heap peak ~1.7 GB). Changing the collector does not help:
// generational ran out at ~23.7G instructions, an aggressive incremental
// pause (100) was too slow to finish (4G instructions in 7.5 min).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, libs, root } from "./tslua.ts";

const engineDir = join(root, "vendor/lua-in-types/src/engine");
const OPTIONS = [
  "--noLib",
  "--noEmit",
  "--skipLibCheck",
  "--allowImportingTsExtensions",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
  "--target",
  "esnext",
];

/** What tsrs says about the same files with the same options. */
function tsrs(files: string[]): { output: string; ms: number } {
  const dir = join(root, ".run/tower");
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, libs.es5.file), readFileSync(libs.es5.path));
  for (const f of files) writeFileSync(join(dir, "engine", f), readFileSync(join(engineDir, f)));
  const t0 = performance.now();
  let output = "";
  try {
    execFileSync(
      join(root, "node_modules/.bin/tsrs"),
      ["--ignoreConfig", ...OPTIONS, libs.es5.file, ...files.map((f) => `engine/${f}`)],
      { cwd: dir, encoding: "utf8", env: { ...process.env, TSRS_FAST: "1" } },
    );
  } catch (e) {
    output = String((e as { stdout?: string }).stdout ?? e);
  }
  return { output, ms: performance.now() - t0 };
}

interface Run {
  instructions?: number;
  countEvery?: number;
  ms: number;
  peakHeapMB?: number;
  heapAfterLoadMB: number;
  heapAfterCheckMB: number;
  status: number;
  output: string;
}

const mb = (kb: number) => Math.round(kb / 102.4) / 10;

/** One check of the engine files; countEvery 0 = no hook. */
async function run(files: string[], countEvery: number): Promise<Run> {
  const extraFiles = Object.fromEntries(
    files.map((f) => [`engine/${f}`, readFileSync(join(engineDir, f), "utf8")]),
  );
  const args = [...OPTIONS, libs.es5.file, ...files.map((f) => `engine/${f}`)];
  const r = await check(
    "",
    libs.es5,
    countEvery > 0
      ? { extraFiles, count: true, peak: true, countEvery, progressEvery: 2_000_000_000 }
      : { extraFiles },
    undefined,
    args,
  );
  const out: Run = {
    ...(countEvery > 0
      ? { instructions: r.instructions!, countEvery, peakHeapMB: mb(r.peakKB!) }
      : {}),
    ms: Math.round(r.ms),
    heapAfterLoadMB: mb(r.heapAfterLoadKB),
    heapAfterCheckMB: mb(r.heapAfterCheckKB),
    status: r.status,
    output: r.output,
  };
  console.log(`  ${files.join(" ")} (hook ${countEvery}):`, JSON.stringify(out));
  return out;
}

async function main() {
  const all = readdirSync(engineDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const bytes = (fs: string[]) => fs.reduce((a, f) => a + statSync(join(engineDir, f)).size, 0);
  // The coarse count (hook 1000) against the exact one on the oracle's largest inputs.
  const manifest = JSON.parse(readFileSync(join(root, "oracle/manifest.json"), "utf8")) as {
    entries: { input: string; lib: string; instructions: number }[];
  };
  const calibration = [];
  for (const e of manifest.entries.filter((x) => x.input.startsWith("extreme/"))) {
    const source = readFileSync(join(root, "oracle/inputs", `${e.input}.ts`), "utf8");
    const r = await check(source, libs[e.lib as "mini" | "es5"], { count: true, countEvery: 1000 });
    calibration.push({
      input: e.input,
      lib: e.lib,
      exact: e.instructions,
      coarse: r.instructions!,
    });
  }
  console.log("calibration", JSON.stringify(calibration));
  // int.ts alone: plain (wall time) and coarse (instructions, heap).
  const single = {
    files: ["int.ts"],
    bytes: bytes(["int.ts"]),
    plain: await run(["int.ts"], 0),
    coarse: await run(["int.ts"], 1000),
    tsrs: tsrs(["int.ts"]),
  };
  const head = {
    generated: "by scripts/tower.ts (vp run tower); do not edit",
    engine: "vendor/lua-in-types/src/engine/*.ts (lua-in-types v1)",
    args: [...OPTIONS, libs.es5.file, "engine/<files>"],
    counting:
      "coarse = count hook of 1000 (1000 per hook call; calibration compares it with the exact count hook of 1 on the oracle's extreme inputs); heap = collectgarbage('count') sampled at each hook call; ms = wall time of that run",
  };
  const write = (r: object) =>
    writeFileSync(
      join(root, "oracle/tower.json"),
      JSON.stringify({ ...head, ...r }, null, 1) + "\n",
    );
  write({ calibration, single, whole: "not measured yet" });
  // Everything: hook 1000 only (an exact count under a hook of 1 runs at ~5M
  // instructions/s here, hours for this).
  const whole = { files: all, bytes: bytes(all), coarse: await run(all, 1000), tsrs: tsrs(all) };
  write({ calibration, single, whole });
  console.log("wrote oracle/tower.json");
}

await main();
