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

Experiment generators: `vendor/lua-in-types/.run/tslua-plan/` is git-ignored
there; copies of the shapes are in this file's appendix.

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
| P1 oracle | ts-in-types | tslua on real Lua (wasmoon) over a few hundred TS inputs, outputs and instruction counts stored; census and profile of what tslua uses |
| P1 front end + IR | lua-in-types `src/aot/front`, `src/aot/ir` | parses and lowers all of tslua and both corpora; IR validates |
| P1 numbers, strings | lua-in-types `src/aot/ref` | exact against wasmoon on generated cases |
| P1 interpreter | lua-in-types `src/aot/ref` | v1 corpus (238) + v2 corpus + fuzz ≡ wasmoon |
| P1 tslua on ref | ts-in-types | byte-identical diagnostics with the oracle on every input |
| P2 type runtime | lua-in-types `src/aot/types` | each primitive ≡ ref on generated cases (int64 first) |
| P3 emitter | lua-in-types `src/aot/emit` | corpus + fuzz: types ≡ ref (output, block count) |
| P4 image + `TS<>` | ts-in-types | one-liner hover shows TS2322 in seconds |
| P5 extremes | ts-in-types | real lib.es5 via staged builds; inner `Add<20, 22>`; the tower (lua-in-types' engine checked by tslua inside the types) |

## Risks

- Dynamic string-keyed maps (symbol tables) are the least proven type-level
  structure; v1's cost over 1,000 instantiations per access.
- 64-bit and float semantics must match Lua exactly; non-ASCII source text is
  bytes, and needs a UTF-8 encoder at the type level.
- The gains of compiled code were measured on toy loops only.
- `pairs` order: tslua is written not to depend on it; if it does somewhere,
  the oracle gate finds it.
- The tower estimate (35-55M Lua instructions) is a guess from the inner
  recursion cost.

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
