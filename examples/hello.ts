// TypeScript 7 (tslua) running inside the type checker. Hover a name to run
// tsc on the source in quotes, with the real lib.es5.d.ts; the hover shows
// what tsc prints. Needs the image: `vp run build` (once, ~10 s). Each hover
// takes tens of seconds and ~5 GB; `node scripts/hover.ts examples/hello.ts Out`
// does the same from a terminal.
import type { TS, TSMini } from "../src/index.ts";

// "main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
export type Out = TS<"const x: number = 'hello';">;

// "" (a clean program prints nothing)
export type Clean = TS<"let a = 1;\na = 2;">;

// "main.ts(2,1): error TS2554: Expected 1-2 arguments, but got 0.\nmain.ts(3,11): error TS2554: Expected 1-2 arguments, but got 3.\n"
export type TwoErrors = TS<'function f(a: number, b?: string) {}\nf();\nf(1, "a", 3);'>;

// A parse error: tsc stops before the checker. This one runs to the end today.
// "main.ts(1,23): error TS1161: Unterminated regular expression literal.\n"
export type Jsx = TS<"const el = <div>hello</div>;">;

// The same one-liner with tslua's 11-line stand-in lib (lua/lib.mini.d.ts).
// "main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
export type OutMini = TSMini<"const x: number = 'hello';">;
