// The stored oracle still holds: rerun a spread of ~20 inputs under wasmoon
// and compare with oracle/expected/ (and, in mini mode, with the instruction
// counts in oracle/manifest.json).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { expectedPath, inputPath, listInputs } from "../scripts/oracle.ts";
import { check, libs, root } from "../scripts/tslua.ts";

const manifest = JSON.parse(readFileSync(join(root, "oracle/manifest.json"), "utf8")) as {
  entries: { input: string; lib: string; instructions: number }[];
};
const counts = new Map(manifest.entries.map((e) => [`${e.input}.${e.lib}`, e.instructions]));

// Every 17th input, plus the type-level addition; the other extremes take seconds.
const all = listInputs().filter((n) => !n.startsWith("extreme/"));
const sample = [...all.filter((_, i) => i % 17 === 0), "extreme/add-20-22"];

describe.each(["mini", "es5"] as const)("oracle (%s)", (lib) => {
  test.each(sample)("%s", async (name) => {
    const source = readFileSync(inputPath(name), "utf8");
    const result = await check(source, libs[lib], { count: lib === "mini" });
    expect(result.output).toBe(readFileSync(expectedPath(name, lib), "utf8"));
    if (lib === "mini") expect(result.instructions).toBe(counts.get(`${name}.${lib}`));
  });
});
