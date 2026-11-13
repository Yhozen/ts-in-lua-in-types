// Scale test: is a tslua-sized body of compiled type code loadable? node gen.mjs <blocks>
// Each block: a cheap body, a static tail jump to the next block, and a function-value interface for dynamic entry.
import { writeFileSync } from "node:fs";
const B = Number(process.argv[2] ?? 150000);
let s = `export type IncD = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9" };
export type Inc<I extends string> = I extends \`\${infer d}\${infer r}\` ? d extends "9" ? \`0\${Inc<r>}\` : \`\${IncD[d & keyof IncD]}\${r}\` : "1";
export interface Fn { arg: unknown; out: unknown }
export type Apply<F extends Fn, X> = (F & { arg: X })["out"];
`;
for (let i = 0; i < B; i++) {
  const next = (i + 1) % B;
  s += `type B${i}<F extends string, A extends string, L, H> = F extends \`x\${infer F2}\` ? Inc<A> extends infer A2 extends string ? A2 extends \`00\${string}\` ? B${next}<F2, A2, [A2, "b${i}", L], H> : B${next}<F2, A2, L, H> : never : ["yield", "b${i}", [A, L, H]];\n`;
  s += `interface I${i} extends Fn { out: this["arg"] extends [infer F extends string, [infer A extends string, infer L, infer H]] ? B${i}<F, A, L, H> : never }\n`;
}
s += `export interface Blocks {\n`;
for (let i = 0; i < B; i++) s += `  b${i}: I${i};\n`;
s += `}\n`;
writeFileSync("code.d.ts", s);
const chunks = 40;
writeFileSync("main.ts", `import type { Apply, Blocks } from "./code";
type Fuel = "${"x".repeat(900)}";
type Run<R> = R extends ["yield", infer K extends keyof Blocks, infer S] ? Apply<Blocks[K], [Fuel, S]> : R;
type S0 = ["yield", "b0", ["0", null, null]];
${Array.from({ length: chunks }, (_, k) => `type S${k + 1} = Run<S${k}>;`).join("\n")}
declare const r: S${chunks}; export const out: ["yield", "b${(chunks * 900) % B}", ["${[...String(chunks * 900)].reverse().join("")}", unknown, null]] = r;
`);
