// A run to its end in one alias, for hovers (lua-in-types' `Exec`, with the
// start in the fuel pool chosen per source).
//
// The checker gives up (returns `any`) after ~5M instantiations since its
// counter was last zeroed, and a hover zeroes it only when a literal type node
// is resolved for the first time. So before every budget chunk the run looks
// up a fresh node of the fuel pool (lua-in-types src/engine/fuel.ts,
// Fuel[chunk][slot]: 4,200 chunks of 64 slots). lua-in-types' Exec starts every
// run of a program at chunk 0 with the program's three slots, so a second
// check in the same editor session would find those nodes already resolved
// and run out of budget. Here the start chunk and the slots come from a hash
// of the source (two Pearson hashes of its first 1,800 characters), and a
// run that reaches the end of the pool starts another lap with other slots.
import type { Fuel, PoolChunks } from "../vendor/lua-in-types/src/engine/fuel.ts";
import type { Inc } from "../vendor/lua-in-types/src/engine/front-num.ts";
import type { Step } from "../image/tslua.mini.d.ts";
import type { Code, KStart, M1, M2, Next, Other1, Other2 } from "./hover.gen.ts";

type X100 =
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
type F900 = `${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}${X100}`;

/** One character into both hashes. */
type Mix<A extends string, B extends string, ch> = ch extends keyof Code
  ? [M1[A & keyof M1][Code[ch]], M2[B & keyof M2][Code[ch]]]
  : [A, B];

/**
 * [h1, h2] of S (its first 1,800 characters, two per step), from A and B.
 * Bindings stay flat: nesting the lookups in one expression makes tsrs
 * check the alias in exponential time.
 */
type Hash<
  S extends string,
  A extends string,
  B extends string,
  F extends string = F900,
> = F extends `x${infer F2}`
  ? S extends `${infer c0}${infer c1}${infer R}`
    ? Mix<A, B, c0> extends [infer A1 extends string, infer B1 extends string]
      ? Mix<A1, B1, c1> extends [infer A2 extends string, infer B2 extends string]
        ? Hash<R, A2, B2, F2>
        : never
      : never
    : Mix<A, B, S> extends [infer A1 extends string, infer B1 extends string]
      ? [A1, B1]
      : never
  : [A, B];

/** Where a run starts in the pool: [start chunk, three slots]. */
export type PoolStart<S extends string, Seed extends string> =
  Hash<S, Seed, Seed> extends [infer A extends keyof KStart, infer B extends keyof Other1]
    ? [KStart[A], [B, Other1[B], Other2[B]]]
    : never;

type Done<S> = S extends [[infer t, ...infer _], ...infer _K]
  ? t extends "D" | "X" | "EXIT"
    ? true
    : false
  : true;

type Refuel<K extends string, Sl> = K extends keyof Fuel
  ? Sl extends keyof Fuel[K]
    ? Fuel[K][Sl]
    : never
  : never;
type Rot<Hs extends string[]> = [Hs[1], Hs[2], Hs[0]];
type Lap<Hs extends string[]> = [
  Next[Hs[0] & keyof Next],
  Next[Hs[1] & keyof Next],
  Next[Hs[2] & keyof Next],
];

type X500 = `${X100}${X100}${X100}${X100}${X100}`;

/** Up to 500 chunks (the checker's tail-recursion limit is ~1,000), then ["more", ...]. Both lib modes share the program, hence Step. */
type Run500<S, K extends string, Hs extends string[], Cn extends string> = 0 extends 1 & S
  ? S // the budget ran out anyway: stop
  : Done<S> extends true
    ? S
    : Cn extends `x${infer C2}`
      ? K extends PoolChunks
        ? Run500<S, "0", Lap<Hs>, Cn>
        : Refuel<K, Hs[0]> extends 0
          ? Step<S> extends infer S2
            ? Run500<S2, Inc<K>, Rot<Hs>, C2>
            : never
          : never
      : ["more", S, K, Hs];
type RunMore<R> = R extends ["more", infer S, infer K extends string, infer Hs extends string[]]
  ? RunMore<Run500<S, K, Hs, X500>>
  : R;

/** Run S0 (the start of a check of Source) to its end, refuelling before every chunk. */
export type Exec<S0, Source extends string, Seed extends string> =
  PoolStart<Source, Seed> extends [infer K extends string, infer Hs extends string[]]
    ? RunMore<Run500<S0, K, Hs, X500>>
    : never;
