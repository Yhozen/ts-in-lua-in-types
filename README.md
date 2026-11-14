# ts-in-lua-in-types

The TypeScript 7 compiler, running inside the TypeScript type checker.

```ts
import type { TS } from "./src/index.ts";

type Out = TS<"const x: number = 'hello';">;
// hover: "main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
```

`TS<Source>` runs the real TypeScript 7 checker on a `main.ts` that holds
`Source`, and the type it evaluates to is what `tsc` prints. No JavaScript
runs at check time. The checker is [tslua](https://github.com/Yhozen/tslua), a
Lua 5.4 port of typescript-go that matches tsgo's diagnostics byte for byte.
[lua-in-types](vendor/lua-in-types) v2 compiles tslua's Lua ahead of time
to type aliases (one per basic-block segment, ~400k of them), and tsrs, a
TypeScript 7 type checker, evaluates them. It is an experiment in how far the
type system goes, not a tool. `docs/PLAN.md` has the plan and the
measurements behind it.

## Where it stands

- **It works.** `TS<"const x: number = 'hello';">` hovers as TS2322 with the
  real `lib.es5.d.ts`, computed by tslua in the type checker: 20 s in a
  fresh editor session.
- All 13,508 compiled functions of tslua (the compiler plus lua-in-types'
  Lua prelude for floats and other slow paths) load from a boot image:
  tslua loaded, the lib parsed and bound, one warm-up check. Each check runs
  from there.
- The gate (`vp run gate:types`) checks oracle inputs through the CLI and
  compares the output with `oracle/expected/` byte for byte. On all 328
  inputs in both lib modes, **409 of 656 checks pass** (mini 210, es5 199;
  [`docs/GATE.md`](docs/GATE.md)). Of the failures:
  - 179 hit TS2589 because one 4-step chunk goes over the checker's 5M
    budget, even though each step fits on its own. Late steps cost ~1M+
    instantiations each.
  - 62 hit the 900 s timeout.
  - 2 give a wrong output: `template-basic` accepts `"id-x"` as
    `` `id-${number}` ``.
  - 1 runs out of chunks.
  - The 2 largest extremes are skipped.
- Cost per reference op grows with the run: the median passing check is
  ~5k instantiations per op, the slowest ~12k.

## Use it

```sh
vp install
vp run boot     # image/boot.<lib>.json: tslua booted on the reference (once, ~1 min)
vp run build    # image/tslua.*.d.ts: the compiled program (~10 s, 290 MB)
```

### In VS Code

1. Install the recommended extension, **TypeScript (Native Preview)**
   (`TypeScriptTeam.native-preview`, listed in `.vscode/extensions.json`).
2. Open the repository folder and trust the workspace. Workspace settings
   only apply to a trusted workspace.
3. `.vscode/settings.json` already sets `"js/ts.experimental.useTsgo": true`
   and `"js/ts.tsdk.path": "./tsdk"`. `tsdk/tsgo` is a two-line wrapper that
   starts tsrs's language server (`node_modules/tsrs/tsdk/tsgo`) with
   `TSRS_FAST=1`, as in gpt2-in-types. If VS Code asks which TypeScript to
   use, or the status bar shows another version, run **TypeScript: Select
   TypeScript Version** and choose **Use Workspace Version**. That step is
   untested here: the server was driven from a terminal (below), not
   clicked through in VS Code.
4. Open `examples/demo.ts` (or `examples/hello.ts`). On open, the server
   computes the file's diagnostics, which evaluates every `TS<...>` in it
   (~1.5 minutes for `hello.ts`). Hovers wait behind that and then take
   5-30 s each.
5. Hover a type name. The comment above each one is the expected output.

Expect the language server to use 8-10 GB. `examples/` has its own
`tsconfig.json`; the image is excluded from search and from `vp check`.

From a terminal, `scripts/hover.ts` drives `tsrs --lsp` the same way, one
session for all the names:

```sh
node scripts/hover.ts examples/demo.ts TypeError Inference ImplicitAny
HOVER_DIAGNOSTICS=1 node scripts/hover.ts examples/hello.ts Out   # diagnostics first, as an editor does
```

| file       | hover               | time | output                                                                                                   |
| ---------- | ------------------- | ---: | -------------------------------------------------------------------------------------------------------- |
| `hello.ts` | `Out`               | 20 s | `main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`                          |
| `hello.ts` | `OutMini`           | 13 s | the same, with the stand-in lib                                                                          |
| `demo.ts`  | `TypeError`         | 14 s | `main.ts(1,5): error TS2322: ...`                                                                        |
| `demo.ts`  | `UnusedExpectError` | 16 s | `main.ts(1,1): error TS2578: Unused '@ts-expect-error' directive.`                                       |
| `demo.ts`  | `Inference`         | 30 s | `main.ts(2,9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.` |
| `demo.ts`  | `PossiblyUndefined` | 13 s | `main.ts(1,46): error TS18048: 's' is possibly 'undefined'.`                                             |
| `demo.ts`  | `ImplicitAny`       |  6 s | `main.ts(1,12): error TS7006: Parameter 'x' implicitly has an 'any' type.`                               |

`examples/add.ts` is the extreme case, `tsc` evaluating a type-level
`Add<20, 22>`. It is ~16x the one-liner's work, and it does not finish yet.
One budget chunk goes past the checker's limits (TS2589) about 17k
trampoline steps in, with 25 or with 10 steps per chunk.

The API (`src/index.ts`):

| type                               | what                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `TS<Source>`                       | tsc's output with the real `lib.es5.d.ts` (one alias, for hovers)                           |
| `TSMini<Source>`                   | the same with tslua's 11-line stand-in lib                                                  |
| `TSStart<Source, "es5" \| "mini">` | the start state, for the CLI                                                                |
| `TSStep<S>`                        | one budget chunk (4 trampoline steps): chain `type S1 = TSStep<S0>; ...`, one per statement |
| `TSOutput<S>`                      | the output once the state is done, `"error: ...\n"` if Lua raised, else `"(still running)"` |

**ASCII only.** Lua strings are bytes, and the source goes to Lua one
character per byte. For non-ASCII text, pass its UTF-8 bytes as the
characters U+0000-U+00FF, as the gate does. Positions then count bytes, and
the output comes back as bytes too.

## What it costs

| step                 | cost                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `vp run build`       | ~10 s: `tslua.prog.d.ts` 263 MB (the code, shared), `tslua.es5.d.ts` 23 MB and `tslua.mini.d.ts` 11 MB (the boot heaps) |
| loading the image    | ~2 s to parse; only what runs is resolved (declaration files, `skipLibCheck`)                                           |
| the one-liner, CLI   | es5: 5,383 chunks, 439M instantiations, 19 s of checking, 7.2 GB peak; mini: 4,129 chunks, 354M, 15 s                   |
| the one-liner, hover | 20 s (es5), 14 s (mini); 8-10 GB peak with five hovers in one session                                                   |
| per IR op            | ~2.6k instantiations, ~150 µs (the reference runs 133k-167k ops for the one-liner)                                      |

A hover refuels the checker's 5M-instantiation budget before every chunk
from a pool of literal type nodes (lua-in-types' `Fuel`, 4,200 x 64). Each
node only works once per session, so `src/hover.ts` picks the start in the
pool and the slots from a hash of the source. That way several checks in one
editor session don't collide. A run longer than the pool starts another lap
with other slots.

## Scripts

| command                            | what                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vp run build`                     | `scripts/build-image.ts`: emit the image (runs `vp run boot` if the snapshots are missing)                                                                                                 |
| `vp run gate:types`                | `scripts/types-gate.ts`: N inputs (default the 20 cheapest; `--all`, `--n`, `--only`, `--lib mini\|es5\|both`, `--jobs`, `--drive`) through the CLI chunk form, against `oracle/expected/` |
| `vp run hover -- FILE TYPE`        | `scripts/hover.ts`: hover through `tsrs --lsp`                                                                                                                                             |
| `vp run gen:hover`                 | `scripts/gen-hover.ts`: the hash tables of `src/hover.gen.ts`                                                                                                                              |
| `vp run ref`, `vp run oracle`, ... | the reference and oracle gates (`AGENTS.md`)                                                                                                                                               |

`src/` and `examples/` load the image, so the root project (`vp run check`)
leaves them out; `examples/tsconfig.json` is their project.
