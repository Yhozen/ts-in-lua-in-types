// tslua under real Lua 5.4 (wasmoon): the ground truth every later stage must
// reproduce. Shared by the oracle, the profile, the tower measurement and the
// tests.
//
// Every check runs in a fresh wasm instance (a new LuaFactory) and a fresh Lua
// state: `require "tsc"` (lua/tsc.lua) loads the compiler, then `tsc.check`
// runs the `tsc` command line on an in-memory project of two files,
// `/p/<lib file>` and `/p/main.ts`.
//
// Why a fresh instance: tslua's work (not its output) depends on `pairs`
// order, which depends on the string hash seed (time(NULL) and the state's
// address) and on table addresses (tables used as keys). In a reused instance
// those addresses depend on what ran before; in a fresh one with Date.now
// frozen and the environment pinned they are always the same, so instruction
// counts are reproducible.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LuaFactory, type LuaEngine } from "wasmoon";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const tsluaSrc = join(root, "vendor/tslua/src");

/** A lib mode: which file stands in for the default library. */
export interface Lib {
  name: "mini" | "es5";
  /** Its name in the project directory, passed on the command line. */
  file: string;
  path: string;
}

export const libs: Record<Lib["name"], Lib> = {
  // tslua's own stand-in default lib (tsctests.tscDefaultLibContent).
  mini: { name: "mini", file: "lib.mini.d.ts", path: join(root, "lua/lib.mini.d.ts") },
  es5: {
    name: "es5",
    file: "lib.es5.d.ts",
    path: join(tsluaSrc, "tslua/bundled/libs/lib.es5.d.ts"),
  },
};

/** The lib goes in as an ordinary root file, with the default lib turned off. */
export const argsFor = (lib: Lib, mainFile = "main.ts"): string[] => [
  "--noLib",
  "--noEmit",
  "--skipLibCheck",
  lib.file,
  mainFile,
];

export function luaSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".lua")) out.push(p);
    }
  };
  walk(tsluaSrc);
  return out;
}

/** The harness modules of this repo (lua/*.lua). */
export function harnessSources(): string[] {
  return readdirSync(join(root, "lua"))
    .filter((f) => f.endsWith(".lua"))
    .sort()
    .map((f) => join(root, "lua", f));
}

export const LUA_PATH = "/t/lua/?.lua;/t/src/?.lua;/t/src/?/init.lua";

let mounts: [string, Buffer][] | undefined;

/** A factory with tslua's sources mounted under /t/src and lua/ under /t/lua. */
export async function createFactory(): Promise<LuaFactory> {
  mounts ??= [
    ...luaSources().map((p): [string, Buffer] => [
      `/t/src/${relative(tsluaSrc, p)}`,
      readFileSync(p),
    ]),
    ...harnessSources().map((p): [string, Buffer] => [
      `/t/lua/${relative(join(root, "lua"), p)}`,
      readFileSync(p),
    ]),
  ];
  // Emscripten copies its environment into the wasm heap, including `_` (the
  // running script's path, process.argv[1]); its length shifts every later
  // address. Pin it.
  const factory = new LuaFactory(undefined, { _: "/tslua" });
  for (const [path, content] of mounts) await factory.mountFile(path, content);
  return factory;
}

export interface CheckOptions {
  /** Count VM instructions with a count hook of 1 (every instruction). */
  count?: boolean;
  /** Also sample collectgarbage("count") every 65,536 instructions (needs count). */
  peak?: boolean;
  /**
   * Hook granularity (default 1, exact). With N > 1 the count is N per hook
   * call, which can be off by a lot on short tight loops (the hook resonates
   * with loop length) but is close on long runs; used for the tower.
   */
  countEvery?: number;
  /** Print progress every this many instructions (needs count). */
  progressEvery?: number;
  /** Lua code run after loading and before the check (e.g. profiling wrappers). */
  prelude?: string;
  /**
   * Lua code run before loading (before `require "tsc"`), so that wrappers it
   * installs are what tslua's `local f = string.f` aliases capture. It may
   * define global functions __BEFORE and __AFTER, called around the check.
   */
  preload?: string;
  /** More files for the project, by path relative to /p (the command line must name them). */
  extraFiles?: Record<string, string>;
  /** Lua code run after the check; its return value comes back as `extra`. */
  epilogue?: string;
}

export interface CheckResult {
  output: string;
  /** tsc's exit status, or -1 when the check raised a Lua error. */
  status: number;
  /** VM instructions spent in `tsc.check` (exact: hook count 1). */
  instructions?: number;
  /** Wall time of the check, ms. */
  ms: number;
  /** Lua heap after loading, KB. */
  heapAfterLoadKB: number;
  /** Highest sampled heap during the check, KB (with `peak`). */
  peakKB?: number;
  /** Lua heap right after the check (no collection forced), KB. */
  heapAfterCheckKB: number;
  extra?: string;
}

const CHECK = `
local files = { [__MAIN_PATH] = __MAIN, [__LIB_PATH] = __LIB }
for i = 1, __EXTRA_N do files[_G["__EXTRA_PATH_" .. i]] = _G["__EXTRA_" .. i] end
local args = {}
for a in string.gmatch(__ARGS, "[^\\n]+") do args[#args + 1] = a end
local n, peak = 0, 0
local hook
local every, progress, nextReport = __COUNT_EVERY, __PROGRESS, __PROGRESS
if every > 1 or progress > 0 then
  hook = function()
    n = n + every
    if __PEAK and (every > 1 or n & 65535 == 0) then
      local m = collectgarbage("count")
      if m > peak then peak = m end
    end
    if progress > 0 and n >= nextReport then
      print(string.format("  ... %d M instructions, heap %d MB", n // 1000000, collectgarbage("count") // 1024))
      nextReport = nextReport + progress
    end
  end
elseif __PEAK then
  hook = function()
    n = n + 1
    if n & 65535 == 0 then
      local m = collectgarbage("count")
      if m > peak then peak = m end
    end
  end
else
  hook = function() n = n + 1 end
end
local before, after = rawget(_G, "__BEFORE"), rawget(_G, "__AFTER")
if before then before() end
if __COUNT then debug.sethook(hook, "", every) end
local ok, out, status = pcall(__TSC.check, files, args)
if __COUNT then debug.sethook() end
if after then after() end
if not ok then out, status = "error: " .. tostring(out) .. "\\n", -1 end
return { out, status, n, peak, collectgarbage("count") }
`;

/**
 * Lua seeds its string hash from time(NULL) (emscripten: Date.now()) and the
 * state's address when the state is created. The seed changes `pairs` order,
 * which changes how many instructions tslua spends (not what it prints), by
 * about 0.1%. Freezing Date.now while a state lives makes counts reproducible;
 * it also makes os.time() return 0.
 */
async function frozenClock<T>(run: () => Promise<T>): Promise<T> {
  const now = Date.now;
  Date.now = () => 0;
  try {
    return await run();
  } finally {
    Date.now = now;
  }
}

export const check = (
  source: string,
  lib: Lib,
  options: CheckOptions = {},
  libSource = readFileSync(lib.path, "utf8"),
  args = argsFor(lib),
): Promise<CheckResult> =>
  frozenClock(async () => checkIn(await createFactory(), source, lib, options, libSource, args));

async function checkIn(
  factory: LuaFactory,
  source: string,
  lib: Lib,
  options: CheckOptions,
  libSource: string,
  args: string[],
): Promise<CheckResult> {
  const lua: LuaEngine = await factory.createEngine();
  try {
    if (options.preload) await lua.doString(options.preload);
    await lua.doString(`package.path = "${LUA_PATH}"; __TSC = require("tsc")`);
    const heapAfterLoadKB = (await lua.doString(`return collectgarbage("count")`)) as number;
    if (options.prelude) await lua.doString(options.prelude);
    lua.global.set("__MAIN_PATH", "/p/main.ts");
    lua.global.set("__MAIN", source);
    const extra = Object.entries(options.extraFiles ?? {});
    lua.global.set("__EXTRA_N", extra.length);
    extra.forEach(([path, text], i) => {
      lua.global.set(`__EXTRA_PATH_${i + 1}`, `/p/${path}`);
      lua.global.set(`__EXTRA_${i + 1}`, text);
    });
    lua.global.set("__LIB_PATH", `/p/${lib.file}`);
    lua.global.set("__LIB", libSource);
    lua.global.set("__ARGS", args.join("\n"));
    lua.global.set("__COUNT", !!options.count);
    lua.global.set("__PEAK", !!options.peak);
    lua.global.set("__COUNT_EVERY", options.countEvery ?? 1);
    lua.global.set("__PROGRESS", options.progressEvery ?? 0);
    const t0 = performance.now();
    const [output, status, n, peak, after] = (await lua.doString(CHECK)) as [
      string,
      number,
      number,
      number,
      number,
    ];
    const ms = performance.now() - t0;
    const tail = options.epilogue ? String(await lua.doString(options.epilogue)) : undefined;
    return {
      output,
      status,
      ms,
      heapAfterLoadKB,
      heapAfterCheckKB: after,
      ...(options.count ? { instructions: n } : {}),
      ...(options.peak ? { peakKB: peak } : {}),
      ...(tail !== undefined ? { extra: tail } : {}),
    };
  } finally {
    lua.global.close();
  }
}

/** VM instructions and wall time of `require "tsc"` in a fresh state. */
export const loadCost = () => frozenClock(loadCostIn);

async function loadCostIn(): Promise<{ instructions: number; ms: number; heapKB: number }> {
  const lua = await (await createFactory()).createEngine();
  try {
    const t0 = performance.now();
    await lua.doString(`package.path = "${LUA_PATH}"; require("tsc")`);
    const ms = performance.now() - t0;
    const lua2 = await (await createFactory()).createEngine();
    try {
      const [n, heap] = (await lua2.doString(`
        package.path = "${LUA_PATH}"
        local n = 0
        debug.sethook(function() n = n + 1 end, "", 1)
        require("tsc")
        debug.sethook()
        return { n, collectgarbage("count") }`)) as [number, number];
      return { instructions: n, ms, heapKB: heap };
    } finally {
      lua2.global.close();
    }
  } finally {
    lua.global.close();
  }
}
