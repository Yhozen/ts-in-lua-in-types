// Compiled ("threaded") version of the toy loop  sum += i; i += 1; until i == n  — no interpreter dispatch.
// node gen-threaded.mjs <variant: direct|mutual|hkt> <N> <fuel>
import { writeFileSync } from "node:fs";
const [variant, N, fuel] = [process.argv[2], process.argv[3] ?? "1000", Number(process.argv[4] ?? 900)];
let tab = "";
for (let c = 0; c < 2; c++) for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) { const s = a + b + c; tab += `  "${c}${a}${b}": ["${s % 10}", "${s >= 10 ? 1 : 0}"];\n`; }
const pre = `
type T = {\n${tab}};
type Add<A extends string, B extends string, C extends string = "0", O extends string = ""> =
  A extends \`\${infer a}\${infer AR}\`
    ? B extends \`\${infer b}\${infer BR}\`
      ? T[\`\${C}\${a}\${b}\` & keyof T] extends [infer d extends string, infer c extends string] ? Add<AR, BR, c, \`\${O}\${d}\`> : never
      : T[\`\${C}\${a}0\` & keyof T] extends [infer d extends string, infer c extends string] ? Add<AR, "", c, \`\${O}\${d}\`> : never
    : B extends \`\${infer b}\${infer BR}\`
      ? T[\`\${C}0\${b}\` & keyof T] extends [infer d extends string, infer c extends string] ? Add<"", BR, c, \`\${O}\${d}\`> : never
      : C extends "1" ? \`\${O}1\` : O;
type Rev<S extends string, O extends string = ""> = S extends \`\${infer h}\${infer t}\` ? Rev<t, \`\${h}\${O}\`> : O;
type Fuel = "${"x".repeat(fuel)}";
`;
let body;
if (variant === "direct") body = `
type B0<F extends string, S extends string, I extends string, N extends string> =
  F extends \`x\${infer F2}\`
    ? Add<S, I> extends infer S2 extends string
      ? Add<I, "1"> extends infer I2 extends string
        ? I2 extends N ? ["done", S2] : B0<F2, S2, I2, N>
        : never
      : never
    : ["yield", S, I, N];
type Run<R> = R extends ["yield", infer S extends string, infer I extends string, infer N extends string] ? B0<Fuel, S, I, N> : R;
`;
else if (variant === "mutual") body = `
type B0<F extends string, S extends string, I extends string, N extends string> =
  F extends \`x\${infer F2}\` ? Add<S, I> extends infer S2 extends string ? B1<F2, S2, I, N> : never : ["yield", S, I, N];
type B1<F extends string, S extends string, I extends string, N extends string> =
  Add<I, "1"> extends infer I2 extends string ? I2 extends N ? ["done", S] : B0<F, S, I2, N> : never;
type Run<R> = R extends ["yield", infer S extends string, infer I extends string, infer N extends string] ? B0<Fuel, S, I, N> : R;
`;
else body = `
interface Fn { arg: unknown; out: unknown }
type Apply<F extends Fn, X> = (F & { arg: X })["out"];
interface Body extends Fn {
  out: this["arg"] extends [infer S extends string, infer I extends string, infer N extends string]
    ? Add<S, I> extends infer S2 extends string
      ? Add<I, "1"> extends infer I2 extends string
        ? I2 extends N ? ["done", S2] : [Body, [S2, I2, N]]
        : never
      : never
    : never;
}
type Loop<R, F extends string> =
  R extends [infer B extends Fn, infer A]
    ? F extends \`x\${infer F2}\` ? Apply<B, A> extends infer R2 ? Loop<R2, F2> : never : ["yield", B, A]
    : R;
type Run<R> = R extends ["yield", infer B extends Fn, infer A] ? Loop<[B, A], Fuel> : R;
`;
const iters = Number(N), per = variant === "mutual" ? fuel : fuel, stmts = Math.ceil(iters / per) + 1;
const s0 = variant === "hkt" ? `["yield", Body, ["0", "0", Rev<"${N}">]]` : `["yield", "0", "0", Rev<"${N}">]`;
const chain = Array.from({ length: stmts }, (_, k) => `type S${k + 1} = Run<S${k}>;`).join("\n");
const expect = [...String(BigInt(N) * (BigInt(N) - 1n) / 2n)].reverse().join("");
writeFileSync(`threaded-${variant}.ts`, `${pre}${body}
type S0 = ${s0};
${chain}
export type Result = S${stmts};
declare const r: Result; export const sum: ["done", "${expect}"] = r;
`);
