// tslua on the lua-in-types v2 reference interpreter (JavaScript): the program,
// the entry chunks and one check, shared by `vp run ref`, `vp run boot` and the
// tests.
//
// The program links the prelude, the modules tslua loads (oracle/modules.json,
// what package.loaded holds after checking every input under real Lua) plus
// lua/tsc.lua and lua/sourcecache.lua, and the entry chunks:
//
//   =boot   require("tsc")                       (loading, once per state)
//   =cache  require("sourcecache").enable()     (keep parsed and bound files across checks)
//   =check  return require("tsc").check(          (one check; per lib mode)
//             { ["/p/main.ts"] = INPUT, ["/p/<lib file>"] = LIB },
//             { "--noLib", "--noEmit", "--skipLibCheck", "<lib file>", "main.ts" })
//
// INPUT and LIB are globals holding the source and the lib text (byte
// strings). `=check` is the per-check entry: the boot image (scripts/boot.ts)
// is the state after `=boot`, `=cache` and a warm-up `=check` of an empty
// INPUT (which parses and binds the lib into the cache), and a check against
// the image runs exactly `=check` with INPUT preset. The gate without the
// image (`vp run ref`) runs `=boot` and `=check` only, as the oracle does.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Program } from "../vendor/lua-in-types/src/aot/ir/ir.ts";
import type { Counters, Interp } from "../vendor/lua-in-types/src/aot/ref/interp.ts";
import {
  bootInterp,
  defaultLibs,
  linkWithPrelude,
  runChunk,
  type ChunkResult,
  type SourceModule,
} from "../vendor/lua-in-types/src/aot/ref/run.ts";
import { restore, snapshot, type Snapshot } from "../vendor/lua-in-types/src/aot/ref/snapshot.ts";
import { toBytes } from "../vendor/lua-in-types/src/aot/ref/value.ts";
import { argsFor, libs, root, tsluaSrc, type Lib } from "./tslua.ts";

export const modulesPath = join(root, "oracle/modules.json");
export const imagePath = (lib: Lib["name"]): string => join(root, `image/boot.${lib}.json`);

/** The source file of a module (tslua's `?.lua;?/init.lua`, and lua/ for ours). */
export function moduleFile(name: string): string | undefined {
  const own = join(root, "lua", `${name}.lua`);
  if (existsSync(own)) return own;
  const base = join(tsluaSrc, ...name.split("."));
  for (const p of [`${base}.lua`, join(base, "init.lua")]) if (existsSync(p)) return p;
  return undefined;
}

/** Chunk and require path as real Lua names them under the oracle's package.path. */
const luaPath = (file: string): string =>
  file.startsWith(tsluaSrc)
    ? `/t/src/${relative(tsluaSrc, file)}`
    : `/t/lua/${relative(join(root, "lua"), file)}`;

export const BOOT = `require("tsc")`;
export const CACHE = `require("sourcecache").enable()`;

/** The per-check entry chunk of a lib mode (INPUT and LIB are globals). */
export const checkChunk = (lib: Lib): string =>
  `return require("tsc").check({ ["/p/main.ts"] = INPUT, ["/p/${lib.file}"] = LIB }, { ${argsFor(
    lib,
  )
    .map((a) => JSON.stringify(a))
    .join(", ")} })\n`;

const entryName = (lib: Lib["name"]) => `\0check.${lib}`;

export function moduleNames(): string[] {
  return (JSON.parse(readFileSync(modulesPath, "utf8")) as { modules: string[] }).modules;
}

/** The linked program (prelude, modules, entry chunks). */
export function refProgram(names = moduleNames()): Program {
  // The lib cache is ours and loaded by =cache only, so real Lua's checks never list it.
  const all = names.includes("sourcecache") ? names : [...names, "sourcecache"];
  const mods: SourceModule[] = all.map((name) => {
    const file = moduleFile(name);
    if (file === undefined) throw new Error(`no source for module ${name}`);
    const path = luaPath(file);
    return { name, chunk: `@${path}`, path, source: toBytes(readFileSync(file, "utf8")) };
  });
  mods.push({ name: "\0boot", chunk: "=boot", path: "", source: BOOT });
  mods.push({ name: "\0cache", chunk: "=cache", path: "", source: CACHE });
  for (const lib of Object.values(libs))
    mods.push({ name: entryName(lib.name), chunk: "=check", path: "", source: checkChunk(lib) });
  return linkWithPrelude(mods, "\0boot");
}

export const libText = (lib: Lib): string => toBytes(readFileSync(lib.path, "utf8"));

export interface RefCheck {
  /** What tsc printed (a byte string), or "error: <message>\n" if the chunk raised. */
  output: string;
  status: number;
  counters: Counters;
  ms: number;
}

const options = () => ({ libs: defaultLibs() });

/** A fresh state with tslua loaded (=boot run) and LIB set; returns the load's counters. */
export function loadedInterp(program: Program, lib: Lib): { interp: Interp; load: ChunkResult } {
  const interp = bootInterp(program, { ...options(), globals: { LIB: libText(lib) } });
  const load = runChunk(interp, program.main);
  if (load.error !== undefined) throw new Error(`loading failed: ${load.error}`);
  return { interp, load };
}

/** Run =check on an idle state with INPUT = source (text). */
export function runCheck(interp: Interp, program: Program, lib: Lib, source: string): RefCheck {
  interp.globals.set("INPUT", toBytes(source));
  const t0 = performance.now();
  const r = runChunk(interp, program.modules[entryName(lib.name)]!);
  const ms = performance.now() - t0;
  if (r.error !== undefined)
    return { output: `error: ${r.error}\n`, status: -1, counters: r.counters, ms };
  return { output: String(r.results[0]), status: Number(r.results[1]), counters: r.counters, ms };
}

/** The boot image of a lib mode: =boot, =cache, a warm-up =check of an empty file, snapshot. */
export function bootImage(program: Program, lib: Lib): { image: Snapshot; warm: RefCheck } {
  const { interp } = loadedInterp(program, lib);
  const cache = runChunk(interp, program.modules["\0cache"]!);
  if (cache.error !== undefined) throw new Error(`=cache failed: ${cache.error}`);
  const warm = runCheck(interp, program, lib, "");
  // The input of the warm-up is not part of the image.
  interp.globals.set("INPUT", undefined);
  return { image: snapshot(interp), warm };
}

/** A fresh state restored from a boot image. */
export const fromImage = (program: Program, image: Snapshot): Interp =>
  restore(program, image, options());
