// Markdown helpers for the generated reports.

/** Lua-style rendering of a byte string: printable ASCII as is, other bytes as \ddd. */
export const esc = (s: string): string =>
  s
    .split("")
    .map((ch) => {
      const b = ch.charCodeAt(0);
      if (ch === "\n") return "\\n";
      if (ch === "\t") return "\\t";
      if (ch === "\r") return "\\r";
      if (b < 0x20 || b > 0x7e) return `\\${b}`;
      return ch === "|" ? "\\|" : ch;
    })
    .join("");

export const code = (s: string): string => "`` " + esc(s) + " ``";

export const table = (head: string[], rows: (string | number)[][]): string =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

export const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Entries by count, descending, then by key. */
export const sorted = (c: Record<string, number>): [string, number][] =>
  Object.entries(c).sort((x, y) => y[1] - x[1] || byName(x[0], y[0]));

export const n = (x: number): string => x.toLocaleString("en-US");
