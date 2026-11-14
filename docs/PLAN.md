# Plan: the TypeScript compiler inside the TypeScript type checker

Goal: hover `type Out = TS<"const x: number = 'hello';">` and see
`main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
computed by the real TypeScript 7 checker running inside tsrs's type checker.
No JavaScript runs at check time.

The checker is tslua (`vendor/tslua`, a faithful Lua 5.4 port of
microsoft/typescript-go that matches tsgo's diagnostics byte for byte on
13,173 conformance configurations). It runs on lua-in-types v2
(`vendor/lua-in-types`, design in its `docs/AOT.md`): Lua compiled ahead of
time to type aliases.

This is an experiment in how far the type system goes, not a tool.

## Measurements (before any code)

tslua under real Lua 5.4 (wasmoon), counting VM instructions with a count hook:

| Step | Lua VM instructions |
|---|---|
| Load the compiler modules (`require "tslua.execute"`) | 1.63-1.69M (`ast` alone 1.14M) |
| Check an empty file with an 11-line stand-in lib | ~135k |
| `const x: number = "hello";` (TS2322) | 153-158k |
| A 6-line program with two errors | 360k |
| An inner type-level `Add<20, 22>` (recursive tuples) | 1.26M (~26k per inner recursion step) |
| The one-liner with the real `lib.es5.d.ts` | 14.3M |

**Correction (oracle, P1):** the counts above used a hook every 1,000
instructions, which resonates with tight loops. Exact counts (hook of 1,
`tsc.check` only, `oracle/manifest.json`): loading 1,619,754; an empty file
236k (mini lib); the one-liner 253,614 (mini) and 14.27M (es5); median over
328 inputs 324k (mini) and 14.34M (es5). A warm-up check in the same state
changes no output and saves exactly 34,129 instructions per later check.

**The tower is out of reach:** tslua checking lua-in-types v1's `int.ts` alone
takes ~8.8G Lua instructions (59 s natively in wasm, 477 MB of Lua heap); the
whole engine runs out of wasm32 memory after ~21G. That is ~160x the guess
below, and far beyond what the types can run. Dropped from P5.

- Heap after loading: 13.8 MB in real Lua; 9,373 tables, 164,177 entries,
  11,752 functions, 24,345 distinct strings (953 KB). A one-liner allocates
  295 KB.
- Builtin calls in the one-liner: `string.byte` 1,444 (strings of at most 291
  bytes), `setmetatable` 690, `string.find` 442, `pairs` 365, `ipairs` 345,
  `string.sub` 321, `string.char` 220, `getmetatable` 113, `string.gsub` 110,
  `string.pack` 96, `table.concat` 33, `table.sort` 11, `math.sqrt` 8.
- Static census of the core (9 MB, 191k lines, 12.5k functions): `&` ~3,750,
  `|` ~1,790, shifts 276, `~` 150, `goto` 323, `//` 165, `/` 56,
  `setmetatable` 485, `error` 905, `pcall` 9, `xpcall` 8, `<const>` 2,
  `<close>` 0, coroutines only in `ipc/pipe.lua`.
- lua-in-types v1 runs ~2.3 stack-VM steps per real Lua instruction.

Type-checker experiments in tsrs (Apple M5 Pro):

| Experiment | Result |
|---|---|
| Loop, interpreted (2 instructions per iteration) | ~218 instantiations, ~10.5 µs, ~2.2 KB per iteration |
| Same loop compiled to a block alias that tail-calls itself | ~26, ~1.07 µs, ~170 B |
| Compiled, bouncing through a `this`-typed function value | ~54, ~3.1 µs, ~1.25 KB |
| Mutual tail calls between two block aliases | work, same cost as direct |
| Three `composite` projects, each resuming from the previous one's emitted `.d.ts` | works; the printer keeps alias names, so state must be plain tuples and objects |
| One 5.7 MB inferred declaration | TS7056 (too long to serialize); 60 declarations of ~85 KB are fine |
| 150k block aliases + 150k interfaces + a 150k-member lookup interface (61 MB `.d.ts`) | parses in 0.52 s, checks in 3.5 s, 1.39 GB (CLI only) |

The generators for these experiments are in `experiments/` (`gen-floor.mjs`,
`gen-threaded.mjs`, `scale/gen.mjs`, `stages/gen.mjs`); the core shapes are in
this file's appendix.

## Architecture

```
vendor/tslua/src/**/*.lua + lua/*.lua (our harness)
   --lua-in-types front + lower-->  IR
   --ref (JavaScript)-->            runs tslua; must print what real Lua prints
   --boot in ref-->                 heap snapshot after `require` (the "image")
   --emit-->                        image.d.ts: one alias per basic block + the heap
TS<"source">  =  run the image's check function on the source, in types
```

Key ideas, tested or not:

1. **Ahead-of-time compilation** (tested on toy loops): each basic block is a
   conditional type; live registers are type parameters; static jumps are
   tail calls between aliases; calls and returns bounce through a trampoline
   that dispatches on a block id via a non-generic lookup interface
   (`(Blocks[K] & { arg: S })["out"]`).
2. **Fuel**: tail-call chains stop at 1,000 hops and the instantiation counter
   at 5M, so the trampoline runs ~900 hops per chunk and draws a literal from
   v1's Fuel pool before each chunk to reset the counter in a hover.
3. **A boot image**: the ~1.7M instructions of `require` run once, offline;
   the heap they build is emitted as a type. A check then costs ~150k
   instructions instead of ~1.8M.
4. **Snapshots through declaration emit** (tested): a `composite` project can
   compute a state and emit it in its `.d.ts`; the next project resumes from
   it in a fresh process. Uses: produce the boot image with the type checker
   itself instead of JavaScript (and check it byte for byte against the ref's),
   run past one checker's memory and cache limits, boot the real
   `lib.es5.d.ts`, and get incremental builds for free.
5. **The checker's caches as memo tables** (untested at scale): identical
   alias instantiations are cached, so `Chars<S>` for `string.byte` and
   method lookups on unchanged class tables are computed once.
6. **Kernel plus prelude**: a small set of type-level builtins; anything that
   calls back into Lua (`sort`, `gsub` with a function, `__tostring`) is
   written in Lua and compiled like the rest.

## Phases and gates

| Phase | Where | Gate |
|---|---|---|
| P0 measurements | here | done (above) |
| P1 oracle | ts-in-lua-in-types | done: 328 inputs, exact counts, census, profile, warm-up |
| P1 front end + IR | lua-in-types `src/aot/front`, `src/aot/ir` | done: all 725 tslua files, 0 failures, <1 s |
| P1 numbers, strings | lua-in-types `src/aot/ref` | done: ~10M random cases, 0 mismatches |
| P1 interpreter | lua-in-types `src/aot/ref` | done: 238 + 103 corpus programs, 10,500 fuzz programs |
| P1 tslua on ref | ts-in-lua-in-types | done: `vp run ref`, 328/328 per lib mode, fresh and from the boot image |
| P2 type runtime | lua-in-types `src/aot/types` | done: int64 (11,835 assertions), tables + heap (4,724), strings + compiled patterns (15,382) |
| P3 emitter | lua-in-types `src/aot/emit` | slice done (234/238 v1 corpus in types); full coverage + start from a snapshot in progress |
| P4 image + `TS<>` | ts-in-lua-in-types | one-liner hover shows TS2322 from the boot image, with the real `lib.es5.d.ts` |
| P5 extremes | ts-in-lua-in-types | inner `Add<20, 22>`; the image produced by the type checker itself through `tsrs -b` stages |

**Boot image (P1, `vp run boot`)**: the state after loading, enabling
`lua/sourcecache.lua` (a compiler host that reuses parsed and bound source
files, like tsgo's parse cache) and one warm-up check. It cuts the es5
one-liner from 14.27M to 125,934 real-Lua instructions with every output
unchanged, so the real lib costs about what the stand-in lib does. From the
image, the es5 one-liner is 167k IR ops, 43k blocks, 10.9k Lua calls, 8.3k
table writes, 1.5k table allocations (median input ~250k ops). The es5 image:
42,787 tables, 293,911 entries, 11,660 closures, ~35k distinct strings
(10.1 MB of JSON).

## Risks

- Dynamic string-keyed maps (symbol tables) are the least proven type-level
  structure; v1's cost over 1,000 instantiations per access.
- 64-bit and float semantics must match Lua exactly; non-ASCII source text is
  bytes, and needs a UTF-8 encoder at the type level.
- The gains of compiled code were measured on toy loops only.
- `pairs` order: tslua is written not to depend on it; if it does somewhere,
  the oracle gate finds it.
- Table writes into a hash part grow superlinearly in time in the emitter
  slice (1,000 writes 0.24 s, 4,000 writes 1.76 s); a check does ~8,300.
  Being fixed.
- A Lua call + return costs ~740 instantiations through the trampoline;
  ~11k per check.

## Appendix: experiment shapes

```ts
// A compiled block: fuel is a string of "x", one per hop.
type B0<F extends string, I extends string, N extends string> =
  F extends `x${infer F2}`
    ? Inc<I> extends infer I2 extends string
      ? I2 extends N ? ["done", I2] : B0<F2, I2, N>
      : never
    : ["yield", I, N];

// Function values through `this` types.
interface Fn { arg: unknown; out: unknown }
type Apply<F extends Fn, X> = (F & { arg: X })["out"];

// A stage of a composite build resuming from the previous stage's output.
//   import { state as prev } from "../s0/stage";
//   type S1 = Run<typeof prev>; ...
//   declare function mk<T>(): T;
//   export const state = mk<S9>();
// tsconfig: composite, declaration, emitDeclarationOnly, references.
```
