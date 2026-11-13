# ts-in-types

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
  compares the output with `oracle/expected/` byte for byte. The 20 inputs
  cheapest on the reference pass in both lib modes. That covers syntax
  errors, clean programs, TS2322, upstream TypeScript cases and the
  one-liner. The other ~300 inputs have not been run in types yet
  (`-- --all`).

## Use it

```sh
vp install
vp run boot     # image/boot.<lib>.json: tslua booted on the reference (once, ~1 min)
vp run build    # image/tslua.*.d.ts: the compiled program (~10 s, 290 MB)
```

Open `examples/hello.ts` in VS Code. `.vscode/settings.json` points the
TypeScript 7 extension at `tsdk/`, which starts tsrs with `TSRS_FAST=1`.
Hover `Out`, `Clean`, `TwoErrors`, `Jsx` or `OutMini`. From a terminal:

```sh
node scripts/hover.ts examples/hello.ts Out Jsx   # tsrs --lsp, like an editor
```

`examples/add.ts` is the extreme case, `tsc` evaluating a type-level
`Add<20, 22>`. It is ~16x the one-liner's work and more chunks than one
hover's fuel pool holds (see below).

The API (`src/index.ts`):

| type                               | what                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `TS<Source>`                       | tsc's output with the real `lib.es5.d.ts` (one alias, for hovers)                            |
| `TSMini<Source>`                   | the same with tslua's 11-line stand-in lib                                                   |
| `TSStart<Source, "es5" \| "mini">` | the start state, for the CLI                                                                 |
| `TSStep<S>`                        | one budget chunk (25 trampoline steps): chain `type S1 = TSStep<S0>; ...`, one per statement |
| `TSOutput<S>`                      | the output once the state is done, `"error: ...\n"` if Lua raised, else `"(still running)"`  |

**ASCII only.** Lua strings are bytes, and the source goes to Lua one
character per byte. For non-ASCII text, pass its UTF-8 bytes as the
characters U+0000-U+00FF, as the gate does. Positions then count bytes, and
the output comes back as bytes too.

## What it costs

| step                 | cost                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `vp run build`       | ~10 s: `tslua.prog.d.ts` 263 MB (the code, shared), `tslua.es5.d.ts` 23 MB and `tslua.mini.d.ts` 11 MB (the boot heaps) |
| loading the image    | ~2 s to parse; only what runs is resolved (declaration files, `skipLibCheck`)                                           |
| the one-liner, CLI   | es5: 862 chunks, 435M instantiations, 26 s of checking, 3.9 GB peak; mini: 661 chunks, 351M, 16 s                       |
| the one-liner, hover | 20 s (es5), 14 s (mini); 8-10 GB peak with five hovers in one session                                                   |
| a syntax error, CLI  | ~280 chunks, 13-50M instantiations, 2-3 s                                                                               |
| per IR op            | ~2.6k instantiations, ~150 µs (the reference runs 133k-167k ops for the one-liner)                                      |

A hover refuels the checker's 5M-instantiation budget before every chunk
from a pool of literal type nodes (lua-in-types' `Fuel`, 4,200 x 64). Each
node only works once per session, so `src/hover.ts` picks the start in the
pool and the slots from a hash of the source. That way several checks in one
editor session don't collide. A run longer than the pool starts another lap
with other slots.

## Scripts

| command                            | what                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp run build`                     | `scripts/build-image.ts`: emit the image (runs `vp run boot` if the snapshots are missing)                                                                                      |
| `vp run gate:types`                | `scripts/types-gate.ts`: N inputs (default the 20 cheapest; `--all`, `--n`, `--only`, `--lib mini\|es5\|both`, `--jobs`) through the CLI chunk form, against `oracle/expected/` |
| `vp run hover -- FILE TYPE`        | `scripts/hover.ts`: hover through `tsrs --lsp`                                                                                                                                  |
| `vp run gen:hover`                 | `scripts/gen-hover.ts`: the hash tables of `src/hover.gen.ts`                                                                                                                   |
| `vp run ref`, `vp run oracle`, ... | the reference and oracle gates (`AGENTS.md`)                                                                                                                                    |

`src/` and `examples/` load the image, so the root project (`vp run check`)
leaves them out; `examples/tsconfig.json` is their project.
