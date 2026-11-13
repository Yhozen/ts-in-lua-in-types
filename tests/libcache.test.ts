// Under real Lua (wasmoon), a check whose lib comes from the cache of a
// warm-up check (lua/sourcecache.lua) prints what the oracle
// printed, and costs what oracle/libcache.json says. The full run is
// `vp run libcache`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { warmup } from "../scripts/libcache.ts";
import { expectedPath, inputPath, listInputs } from "../scripts/oracle.ts";
import { check, libs, root } from "../scripts/tslua.ts";

const rows = (
  JSON.parse(readFileSync(join(root, "oracle/libcache.json"), "utf8")) as {
    rows: { input: string; lib: string; cached: number }[];
  }
).rows;
const cached = new Map(rows.map((r) => [`${r.input}.${r.lib}`, r.cached]));
const sample = listInputs().filter((n, i) => i % 41 === 0 || n === "assign-basic");

describe.each(["mini", "es5"] as const)("lib cache (%s)", (lib) => {
  test.each(sample)("%s", async (name) => {
    const r = await check(readFileSync(inputPath(name), "utf8"), libs[lib], {
      count: true,
      prelude: warmup(libs[lib]),
    });
    expect(r.output).toBe(readFileSync(expectedPath(name, lib), "utf8"));
    expect(r.instructions).toBe(cached.get(`${name}.${lib}`));
  });
});
