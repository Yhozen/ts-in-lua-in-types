// tsc, running inside the type checker. Each type below runs TypeScript 7's
// checker (tslua, compiled to types) on the program in quotes, with the real
// lib.es5.d.ts, and evaluates to what tsc prints. TypeScript 7 is strict by
// default. Hover a name; the comment above it is what the hover shows.
//
// Left out for time, though both come out right: a missing property (TS2741,
// ~90 s to hover) and a "Did you mean 'name'?" suggestion (TS2561, ~50 s on
// the CLI).
import type { TS } from "../src/index.ts";

// "main.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
export type TypeError = TS<'let n: number = "forty-two";'>;

// "main.ts(1,1): error TS2578: Unused '@ts-expect-error' directive.\n"
export type UnusedExpectError = TS<'// @ts-expect-error\nconst ok: string = "fine";'>;

// "main.ts(2,9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n"
export type Inference = TS<'function pair<T>(a: T, b: T): T[] { return [a, b]; }\npair(1, "two");'>;

// "main.ts(1,46): error TS18048: 's' is possibly 'undefined'.\n"
export type PossiblyUndefined = TS<"function len(s: string | undefined) { return s.length; }">;

// "main.ts(1,12): error TS7006: Parameter 'x' implicitly has an 'any' type.\n"
export type ImplicitAny = TS<"function f(x) { return x; }">;
