// Does a warm-up check change later checks? Question for the boot image: could
// it include one check already done (lazy inits such as
// tslua.locale.language_generated), and what would that save?
//
//   vp run warmup  -> oracle/warmup.json
//
// For each input: a fresh state loads tslua, runs tsc.check on an empty
// main.ts (same lib, same command line), then checks the input under the
// count hook. Compared with the oracle (no warm-up): output and instructions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedPath, inputPath, listInputs } from "./oracle.ts";
import { runPool, type Job } from "./pool.ts";
import { argsFor, libs, root, type Lib } from "./tslua.ts";

const warmup = (lib: Lib) => `
local files = { ["/p/main.ts"] = "", ["/p/${lib.file}"] = [=====[${readFileSync(lib.path, "utf8")}]=====] }
__WARM_OUT = __TSC.check(files, { ${argsFor(lib)
  .map((a) => JSON.stringify(a))
  .join(", ")} })`;

async function main() {
  const manifest = JSON.parse(readFileSync(join(root, "oracle/manifest.json"), "utf8")) as {
    entries: { input: string; lib: string; instructions: number }[];
  };
  const exact = new Map(manifest.entries.map((e) => [`${e.input}.${e.lib}`, e.instructions]));
  const names = listInputs();
  const plan = [
    ...names.map((name) => ({ name, lib: "mini" as const })),
    ...names.filter((_, i) => i % 8 === 0).map((name) => ({ name, lib: "es5" as const })),
  ];
  const preludes = { mini: warmup(libs.mini), es5: warmup(libs.es5) };
  const jobs: Job[] = plan.map(({ name, lib }, id) => ({
    id,
    source: readFileSync(inputPath(name), "utf8"),
    lib,
    options: { count: true, prelude: preludes[lib], epilogue: "return __WARM_OUT" },
  }));
  const results = await runPool(jobs, () => {});
  const rows = results.map((r) => {
    const { name, lib } = plan[r.id]!;
    const cold = exact.get(`${name}.${lib}`)!;
    return {
      input: name,
      lib,
      sameOutput: r.result.output === readFileSync(expectedPath(name, lib), "utf8"),
      warmupOutputEmpty: r.result.extra === "",
      cold,
      warm: r.result.instructions!,
      saved: cold - r.result.instructions!,
    };
  });
  const summary = Object.fromEntries(
    (["mini", "es5"] as const).map((lib) => {
      const xs = rows.filter((x) => x.lib === lib);
      const saved = xs.map((x) => x.saved).sort((a, b) => a - b);
      const frac = xs.map((x) => x.saved / x.cold).sort((a, b) => a - b);
      return [
        lib,
        {
          inputs: xs.length,
          outputsChanged: xs.filter((x) => !x.sameOutput).map((x) => x.input),
          savedMin: saved[0],
          savedMedian: saved[saved.length >> 1],
          savedMax: saved[saved.length - 1],
          savedFractionMedian: Math.round(frac[frac.length >> 1]! * 1000) / 1000,
        },
      ];
    }),
  );
  writeFileSync(
    join(root, "oracle/warmup.json"),
    JSON.stringify(
      { generated: "by scripts/warmup.ts (vp run warmup); do not edit", summary, rows },
      null,
      1,
    ) + "\n",
  );
  console.log(JSON.stringify(summary, null, 1));
}

await main();
