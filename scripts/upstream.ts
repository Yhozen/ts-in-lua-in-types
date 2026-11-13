// Pick ~150 single-file cases from microsoft/TypeScript tests/cases/compiler
// (at the commit typescript-go's TypeScript submodule pins for tslua's
// UPSTREAM_COMMIT) and copy them to oracle/inputs/upstream/.
//
//   vp run upstream
//
// A sparse shallow clone goes to .run/ts-cases. Candidates are single-file
// (no `@filename`), under 2 KB, need no lib beyond es5 (no `@lib`, no DOM, no
// es2015+ globals; checked by running tslua on them with lib.es5.d.ts and
// rejecting "change your target library" style diagnostics), and do not crash
// tslua. Cases tslua lists as passing (submodule/compiler/ in tests/passing/errors.txt) come first.
// The selection is a deterministic hash order over the names.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPool, type Job } from "./pool.ts";
import { root } from "./tslua.ts";

export const TYPESCRIPT_COMMIT = "5848bc5157b22ff7f4e3369f4645a514a433b15f";
const COUNT = 150;
const MAX_BYTES = 2048;

const clone = join(root, ".run/ts-cases");
const casesDir = join(clone, "tests/cases/compiler");
const outDir = join(root, "oracle/inputs/upstream");

function fetchCases() {
  if (existsSync(casesDir)) return;
  mkdirSync(clone, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: clone, stdio: "inherit" });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/microsoft/TypeScript.git");
  git("sparse-checkout", "set", "--no-cone", "/tests/cases/compiler/");
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", TYPESCRIPT_COMMIT);
  git("checkout", "-q", "FETCH_HEAD");
}

/** Directives that bring in other files, libs, JS or JSX. */
const REJECT_DIRECTIVE =
  /^\s*\/\/\s*@(filename|lib|jsx|allowJs|checkJs|types|typeRoots|noLib|moduleResolution|baseUrl|paths|rootDir|outDir|outFile|out|declarationDir|composite|isolatedDeclarations|emitDecoratorMetadata|experimentalDecorators|libFiles|link|currentDirectory|symlink|noTypesAndSymbols)\s*:/im;
/** References to other files or to the outside world. */
const REJECT_TEXT =
  /\/\/\/\s*<reference|\bimport\s[^;]*\bfrom\s|\bimport\s*\(|\brequire\s*\(|\bexport\s*=|\bdocument\b|\bwindow\b|\bHTML\w*Element\b|\bconsole\b|\bPromise\b|\basync\b|\bawait\b|\bSymbol\b|\bMap\b|\bSet\b|\bWeakMap\b|\bIterable\w*\b|\bGenerator\b|\bfunction\s*\*|\bBigInt\b|\d+n\b|\bProxy\b|\bReflect\b/;
/** es5 diagnostics that mean the case wants a bigger lib. */
const REJECT_OUTPUT =
  /change your target library|change the 'lib' compiler option|include 'dom'|error TS(2318|2583|2584|2585|2550|2468|2705|2712|2697|2802|2504|2488|1378|2569|18028):/;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  fetchCases();
  const passing = new Set(
    readFileSync(join(root, "vendor/tslua/tests/passing/errors.txt"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("submodule/compiler/"))
      .map((l) => l.slice("submodule/compiler/".length).replace(/\(.*$/, "")),
  );
  const candidates = readdirSync(casesDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".tsx"))
    .filter((f) => {
      const text = readFileSync(join(casesDir, f), "utf8");
      return (
        Buffer.byteLength(text) < MAX_BYTES - 200 &&
        !REJECT_DIRECTIVE.test(text) &&
        !REJECT_TEXT.test(text) &&
        // Plain ASCII keeps byte and UTF-16 columns equal; the hand-written inputs cover non-ASCII.
        // oxlint-disable-next-line no-control-regex
        /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text.replace(/^﻿/, ""))
      );
    })
    .sort((a, b) => {
      const pa = passing.has(a) ? 0 : 1;
      const pb = passing.has(b) ? 0 : 1;
      return pa - pb || (hash(a) < hash(b) ? -1 : 1);
    });
  console.log(
    `${candidates.length} candidates (${candidates.filter((c) => passing.has(c)).length} listed as passing)`,
  );

  // Screen twice as many as needed, in es5 mode.
  const screen = candidates.slice(0, COUNT * 2);
  const jobs: Job[] = screen.map((f, id) => ({
    id,
    source: readFileSync(join(casesDir, f), "utf8"),
    lib: "es5",
    options: {},
  }));
  const results = await runPool(jobs, () => {});
  const chosen: string[] = [];
  let crashed = 0;
  let wantsLib = 0;
  for (const r of results) {
    if (chosen.length === COUNT) break;
    if (r.result.status === -1) crashed++;
    else if (REJECT_OUTPUT.test(r.result.output)) wantsLib++;
    else chosen.push(screen[r.id]!);
  }
  console.log(
    `chosen ${chosen.length}; rejected ${crashed} crashes, ${wantsLib} needing a bigger lib`,
  );

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of chosen) {
    const text = readFileSync(join(casesDir, f), "utf8").replace(/^﻿/, "");
    // The header uses the file's own line ending (many cases are CRLF; kept byte for byte).
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const header = `// microsoft/TypeScript tests/cases/compiler/${f} at ${TYPESCRIPT_COMMIT.slice(0, 12)} (Apache-2.0).${eol}// Its // @ directives are kept as comments; the oracle does not apply them.${eol}`;
    writeFileSync(join(outDir, f), header + text);
  }
  writeFileSync(
    join(outDir, "README.md"),
    `# Upstream compiler cases

Generated by \`scripts/upstream.ts\` (\`vp run upstream\`); do not edit.

${chosen.length} single-file cases from
[microsoft/TypeScript](https://github.com/microsoft/TypeScript) \`tests/cases/compiler\`
at commit \`${TYPESCRIPT_COMMIT}\` (the TypeScript submodule of the typescript-go
commit tslua ports, \`vendor/tslua/UPSTREAM_COMMIT\`).

Each file is the original, byte for byte (many use CRLF line endings, which
\`.gitattributes\` keeps), with a two-line header comment prepended in the
file's own line ending (so positions in the oracle's output are shifted by two
lines). The original
\`// @\` directives (\`@target\`, \`@strict\`, ...) are kept as comments; the
oracle runs every input with the same command line and does not apply them.

Selection: no \`@filename\` (single file), no \`@lib\`/JSX/JS, under 2 KB,
ASCII only, no imports or references, no DOM or es2015+ globals, and tslua's
es5-mode output contains no diagnostic asking for a bigger lib. Cases tslua
lists as passing (\`vendor/tslua/tests/passing/errors.txt\`) come first, then a
deterministic hash order.

## License

These files are copyright Microsoft Corporation and licensed under the Apache
License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). They are
distributed here unmodified apart from the header comment. Unless required by
applicable law or agreed to in writing, they are distributed on an "AS IS"
BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
`,
  );
}

await main();
