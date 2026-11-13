// tslua on the lua-in-types reference prints what real Lua printed
// (oracle/expected/), byte for byte, on a spread of ~20 inputs per lib mode:
// in a fresh state, and restored from a boot image built in the test (the
// full gate is `vp run ref` and `vp run ref -- --image`).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import type { Snapshot } from "../vendor/lua-in-types/src/aot/ref/snapshot.ts";
import { bootImage, fromImage, loadedInterp, refProgram, runCheck } from "../scripts/luaref.ts";
import { expectedPath, inputPath, listInputs } from "../scripts/oracle.ts";
import { libs } from "../scripts/tslua.ts";

const all = listInputs().filter((n) => !n.startsWith("extreme/"));
const sample = [...all.filter((_, i) => i % 17 === 0), "extreme/add-20-22"];
const program = refProgram();
const images = new Map<string, Snapshot>();

const expected = (name: string, lib: "mini" | "es5") =>
  readFileSync(expectedPath(name, lib)).toString("latin1");

describe.each(["mini", "es5"] as const)("reference (%s)", (lib) => {
  test.each(sample)("%s", (name) => {
    const { interp } = loadedInterp(program, libs[lib]);
    const r = runCheck(interp, program, libs[lib], readFileSync(inputPath(name), "utf8"));
    expect(r.output).toBe(expected(name, lib));
  });

  test.each(sample.filter((_, i) => i % 3 === 0))("%s from the boot image", (name) => {
    let image = images.get(lib);
    if (image === undefined) {
      image = JSON.parse(JSON.stringify(bootImage(program, libs[lib]).image)) as Snapshot;
      images.set(lib, image);
    }
    const interp = fromImage(program, image);
    const r = runCheck(interp, program, libs[lib], readFileSync(inputPath(name), "utf8"));
    expect(r.output).toBe(expected(name, lib));
  });
});
