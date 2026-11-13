// The TypeScript 7 compiler (tslua) as a type: `TS<"source">` runs tslua's
// `tsc --noLib --noEmit --skipLibCheck lib.es5.d.ts main.ts` on a main.ts
// holding the source, inside the type checker (tsrs), and evaluates to what
// tsc prints: its diagnostics, "" for a clean program. Exactly what
// oracle/expected/<name>.<lib>.txt holds for the same input.
//
// The compiler is the image built by `vp run build` (image/, git-ignored):
// tslua compiled to type aliases by lua-in-types v2, started from the boot
// image (tslua loaded, the lib parsed and bound, one warm-up check). A check
// runs the per-check chunk (scripts/luaref.ts, `=check`) with INPUT = Source.
//
// Source must be ASCII: Lua strings are bytes, and a type-level string is
// passed to Lua as is, one character per byte. A non-ASCII character would
// need a type-level UTF-8 encoder (and positions in the output count bytes).
//
// Hovers: TS<> and TSMini<> run to the end in one alias, refuelling the
// checker's instantiation budget before every chunk. CLI checks reset that
// budget per statement, so they chain chunks instead (as lua-in-types' Step):
//
//   type S0 = TSStart<"const x: number = 'hello';">;
//   type S1 = TSStep<S0>;
//   ...
//   type Out = TSOutput<S300>;   // "(still running)" until the run has ended
import type { S0 as StartEs5 } from "../image/tslua.es5.d.ts";
import type { S0 as StartMini, Step } from "../image/tslua.mini.d.ts";
import type { ErrMsg } from "../vendor/lua-in-types/src/aot/types/value.ts";
import type { Exec } from "./hover.ts";

/** tsc's output for main.ts = Source, with the real lib.es5.d.ts. */
export type TS<Source extends string> = TSOutput<Exec<StartEs5<Source>, Source, "0">>;

/** The same with tslua's 11-line stand-in lib (lua/lib.mini.d.ts): cheaper, fewer globals. */
export type TSMini<Source extends string> = TSOutput<Exec<StartMini<Source>, Source, "1">>;

/** A lib mode: "es5" (lib.es5.d.ts) or "mini" (lua/lib.mini.d.ts). */
export type TSLib = "es5" | "mini";

/** The state that starts a check of Source (CLI chunk form). */
export type TSStart<Source extends string, Lib extends TSLib = "es5"> = Lib extends "mini"
  ? StartMini<Source>
  : StartEs5<Source>;

/**
 * One budget chunk of a check (4 trampoline steps): one CLI statement each.
 * A finished state stays as it is. Both lib modes run the same program.
 */
export type TSStep<S> = Step<S>;

/**
 * What tsc printed, from a state: its output once the check has returned,
 * "error: <message>\n" if Lua raised an error (as the oracle prints it), and
 * "(still running)" before the end.
 */
export type TSOutput<S> = S extends [infer R, ...infer _]
  ? R extends ["D", infer _H, infer _O, [infer Out extends string, ...infer _V]]
    ? Out
    : R extends ["X", infer _H, infer O extends string, infer E]
      ? `${O}error: ${ErrMsg<E>}\n`
      : R extends ["EXIT", ...infer _]
        ? "(exited)"
        : "(still running)"
  : never;

/** The state's request tag: "D" (done), "X" (raised), else running ("J", "C", ...). */
export type TSTag<S> = S extends [[infer T, ...infer _], ...infer _K] ? T : never;
