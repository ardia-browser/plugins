import table from "../assets/served.txt" with { type: "text" };

export const SERVING_SIDES = ["rust", "ts"] as const;
export type ServingSide = (typeof SERVING_SIDES)[number];

export function servedTable(text: string = table): Map<string, ServingSide> {
  const rows = new Map<string, ServingSide>();
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    const side = words.at(-1);
    const label = words.slice(0, -1).join(" ");
    if (words.length >= 2 && (side === "rust" || side === "ts") && !rows.has(label)) rows.set(label, side);
  }
  return rows;
}

export function servesNatively(label: string, table: Map<string, ServingSide> = servedTable()): boolean {
  return table.has(label);
}
