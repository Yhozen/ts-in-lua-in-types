// The boot image: tslua loaded and warmed up on the reference, as a snapshot.
//
//   vp run boot   -> image/boot.<lib>.json (git-ignored) and oracle/boot.json (sizes)
//
// Per lib mode: a fresh reference state runs =boot (require "tsc") with LIB
// set, then one =check of an empty main.ts (the warm-up: lazy requires and
// caches that every later check would otherwise fill), then
// vendor/lua-in-types/src/aot/ref/snapshot.ts captures it. A check against the
// image restores it, sets INPUT and runs =check (scripts/luaref.ts); that is
// what the type-level image will run. `vp run ref -- --image` gates it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { snapshot, snapshotStats } from "../vendor/lua-in-types/src/aot/ref/snapshot.ts";
import { bootImage, checkChunk, fromImage, imagePath, refProgram } from "./luaref.ts";
import { counterRow } from "./ref.ts";
import { libs, root } from "./tslua.ts";

async function main() {
  const t0 = performance.now();
  const program = refProgram();
  console.log(
    `linked ${program.protos.length} protos (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
  const report: Record<string, unknown> = {};
  for (const lib of Object.values(libs)) {
    const t1 = performance.now();
    const { image, warm } = bootImage(program, lib);
    if (warm.output !== "" || warm.status !== 0)
      throw new Error(`warm-up printed ${JSON.stringify(warm.output)} (status ${warm.status})`);
    const json = JSON.stringify(image);
    const path = imagePath(lib.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json);
    // The file restores to the same state.
    const back = JSON.parse(readFileSync(path, "utf8")) as typeof image;
    const again = JSON.stringify(snapshot(fromImage(program, back)));
    if (again !== json) throw new Error(`image/boot.${lib.name}.json does not restore exactly`);
    const stats = snapshotStats(image);
    report[lib.name] = {
      file: `image/boot.${lib.name}.json`,
      bytes: Buffer.byteLength(json),
      ...stats,
      entries: stats.arrayItems + stats.slots,
      checkChunk: checkChunk(lib),
      warmup: counterRow(warm.counters),
    };
    console.log(
      `${lib.name}: ${(Buffer.byteLength(json) / 1e6).toFixed(1)} MB, ${stats.tables} tables, ${stats.arrayItems + stats.slots} entries, ${stats.closures} closures, ${stats.cells} cells, ${stats.strings} strings (${(stats.stringBytes / 1e3).toFixed(0)} KB) (${((performance.now() - t1) / 1000).toFixed(1)} s)`,
    );
  }
  writeFileSync(
    join(root, "oracle/boot.json"),
    JSON.stringify(
      {
        generated: "by scripts/boot.ts (vp run boot); do not edit",
        image:
          "state after =boot (require 'tsc'), =cache (require 'sourcecache'.enable()) and a warm-up =check of an empty main.ts, LIB set: the lib is parsed and bound in the cache; entries = array items + hash slots",
        program: { protos: program.protos.length },
        ...report,
      },
      null,
      1,
    ) + "\n",
  );
  console.log("wrote oracle/boot.json");
}

if (import.meta.main) await main();
