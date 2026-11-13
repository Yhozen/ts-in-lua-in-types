// The extreme: tsc computing a type-level Add<20, 22> (recursive tuples)
// while running inside the type checker. ~16x the work of examples/hello.ts
// on the reference (2.6M IR ops): expect minutes per hover.
import type { TS } from "../src/index.ts";

// "main.ts(3,7): error TS2322: Type '\"forty-two\"' is not assignable to type '42'.\n"
export type Sum = TS<`type Tuple<N extends number, T extends unknown[] = []> = T["length"] extends N ? T : Tuple<N, [...T, unknown]>;
type Add<A extends number, B extends number> = [...Tuple<A>, ...Tuple<B>]["length"];
const sum: Add<20, 22> = "forty-two";`>;
