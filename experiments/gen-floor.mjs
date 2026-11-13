// Control-flow floor: the loop body is one cheap increment. node gen-floor.mjs <direct|hkt|interp> <N> <fuel>
import { writeFileSync } from "node:fs";
const [variant, N, fuel] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 900)];
const pre = `
type IncD = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9" };
type Inc<I extends string> = I extends \`\${infer d}\${infer r}\` ? d extends "9" ? \`0\${Inc<r>}\` : \`\${IncD[d & keyof IncD]}\${r}\` : "1";
type Rev<S extends string, O extends string = ""> = S extends \`\${infer h}\${infer t}\` ? Rev<t, \`\${h}\${O}\`> : O;
type Fuel = "${"x".repeat(fuel)}";
`;
let body, s0;
if (variant === "direct") { s0 = `["yield", "0", Rev<"${N}">]`; body = `
type B0<F extends string, I extends string, N extends string> =
  F extends \`x\${infer F2}\` ? Inc<I> extends infer I2 extends string ? I2 extends N ? ["done", I2] : B0<F2, I2, N> : never : ["yield", I, N];
type Run<R> = R extends ["yield", infer I extends string, infer N extends string] ? B0<Fuel, I, N> : R;`; }
else if (variant === "hkt") { s0 = `["yield", Body, ["0", Rev<"${N}">]]`; body = `
interface Fn { arg: unknown; out: unknown }
type Apply<F extends Fn, X> = (F & { arg: X })["out"];
interface Body extends Fn {
  out: this["arg"] extends [infer I extends string, infer N extends string]
    ? Inc<I> extends infer I2 extends string ? I2 extends N ? ["done", I2] : [Body, [I2, N]] : never : never;
}
type Loop<R, F extends string> =
  R extends [infer B extends Fn, infer A] ? F extends \`x\${infer F2}\` ? Apply<B, A> extends infer R2 ? Loop<R2, F2> : never : ["yield", B, A] : R;
type Run<R> = R extends ["yield", infer B extends Fn, infer A] ? Loop<[B, A], Fuel> : R;`; }
else { // interpreter: bytecode tuple, pc, 8-register tuple rebuilt on write (the earlier toy design), 2 instructions per iteration
  s0 = `["yield", 0, ["0", Rev<"${N}">, "0", "0", "0", "0", "0", "0"]]`; body = `
type Prog = [["inc", "0"], ["jne", "0", "1", 0], ["halt"]];
type Next = [1, 2, 3];
type Set<R extends unknown[], K extends string, V extends string, O extends string[] = []> = R extends [infer H extends string, ...infer RR] ? Set<RR, K, V, [...O, \`\${O["length"]}\` extends K ? V : H]> : O;
type Step<F extends string, PC extends number, R extends string[]> =
  F extends \`x\${infer F2}\`
    ? Prog[PC & keyof Prog] extends infer I
      ? I extends ["inc", infer D extends string]
        ? Set<R, D, Inc<R[D & keyof R] & string>> extends infer R2 extends string[] ? Step<F2, Next[PC & keyof Next], R2> : never
        : I extends ["jne", infer A extends string, infer B extends string, infer L extends number]
          ? R[A & keyof R] extends R[B & keyof R] ? Step<F2, Next[PC & keyof Next], R> : Step<F2, L, R>
          : ["done", R[0]]
      : never
    : ["yield", PC, R];
type Run<R> = R extends ["yield", infer PC extends number, infer RG extends string[]] ? Step<Fuel, PC, RG> : R;`; }
const per = variant === "interp" ? fuel / 2 : fuel, stmts = Math.ceil(Number(N) / per) + 1;
writeFileSync(`floor-${variant}.ts`, `${pre}${body}
type S0 = ${s0};
${Array.from({ length: stmts }, (_, k) => `type S${k + 1} = Run<S${k}>;`).join("\n")}
declare const r: S${stmts}; export const out: ["done", "${[...String(N)].reverse().join("")}"] = r;
`);
