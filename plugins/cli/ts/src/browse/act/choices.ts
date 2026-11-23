import { BrowseError } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";

export const MAX_OPTIONS_LISTED = 20;
const NOT_A_FINAL_KEY = /^[\n\r\t\p{M}‍︎️]$/u;

export function splitFinal(text: string): [string, string] | null {
  const chars = Array.from(text);
  const last = chars.at(-1);
  if (last === undefined || NOT_A_FINAL_KEY.test(last)) return null;
  return [chars.slice(0, -1).join(""), last];
}

export const OVERLAY_INPUT = `(el) => {
  const doc = el.ownerDocument;
  let active = doc.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  if (!active || active === el || active === doc.body || (el.contains && el.contains(active))) return null;
  const tag = active.tagName;
  const kind = (active.type || "text").toLowerCase();
  const textual = tag === "TEXTAREA" || (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "hidden", "file", "range", "color", "image"].includes(kind));
  if (!(active.isContentEditable || textual) || active.readOnly || active.disabled) return null;
  const ids = [el.getAttribute("aria-controls"), el.getAttribute("aria-owns")].filter(Boolean).join(" ").split(/\\s+/).filter(Boolean);
  const root = el.getRootNode();
  const linked = ids.some((id) => {
    const node = (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id);
    return !!node && (node === active || node.contains(active));
  });
  const popup = active.closest("[role=listbox], [role=dialog], [role=menu], [role=combobox], [role=tree], [role=grid], [popover], dialog");
  const role = (el.getAttribute("role") || "").toLowerCase();
  const opener = role === "combobox" || /^(listbox|dialog|menu|tree|grid|true)$/.test((el.getAttribute("aria-haspopup") || "").toLowerCase());
  return linked || (opener && popup) ? active : null;
}`;

export const CHECK_STATE = `(el) => {
  const tag = el.tagName;
  if (tag === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return el.indeterminate ? "mixed" : el.checked;
  for (const name of ["aria-checked", "aria-pressed", "aria-selected"]) {
    const value = (el.getAttribute(name) || "").toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "mixed") return "mixed";
  }
  const inner = el.querySelector && el.querySelector("input[type=checkbox], input[type=radio]");
  if (inner) return inner.indeterminate ? "mixed" : inner.checked;
  const control = tag === "LABEL" && el.control;
  if (control && (control.type === "checkbox" || control.type === "radio")) return control.checked;
  return null;
}`;

export function checkedFrom(value: unknown): boolean | "mixed" | null {
  if (value === true || value === false || value === "mixed") return value;
  return null;
}

export type OptionRow = { value: string; label: string; text: string; disabled?: boolean };

export const OPTION_ROWS =
  "(list) => list.tagName === 'SELECT' ? Array.from(list.options).map((o) => ({ value: o.value, label: (o.label || '').replace(/\\s+/g, ' ').trim(), text: (o.textContent || '').replace(/\\s+/g, ' ').trim(), disabled: o.disabled })) : null";

function optionName(row: OptionRow): string {
  const shown = row.label || row.text || row.value;
  const value = row.value && row.value !== shown ? ` (value ${JSON.stringify(row.value)})` : "";
  return `"${shown}"${value}${row.disabled ? " [disabled]" : ""}`;
}

export function listOptions(rows: readonly OptionRow[]): string {
  const listed = rows.slice(0, MAX_OPTIONS_LISTED).map(optionName).join(", ");
  return rows.length > MAX_OPTIONS_LISTED ? `${listed} (and ${rows.length - MAX_OPTIONS_LISTED} more)` : listed;
}

const TIERS: readonly ((row: OptionRow, value: string) => boolean)[] = [
  (row, value) => row.value === value,
  (row, value) => row.label === value,
  (row, value) => row.text === value,
];

export function matchOptions(values: readonly string[], rows: readonly OptionRow[], where: string): string[] {
  return values.map((value) => {
    for (const tier of TIERS) {
      const hits = rows.filter((row) => tier(row, value));
      const distinct = [...new Set(hits.map((row) => row.value))];
      if (distinct.length === 1) return distinct[0] as string;
      if (distinct.length > 1) {
        flag("select_listed_options", true);
        throw new BrowseError(
          `"${value}" matches ${hits.length} options of ${where}: ${listOptions(hits)}. Give the option's value to pick one`,
          { options: hits.map((row) => ({ value: row.value, label: row.label || row.text })) },
          "ambiguous",
        );
      }
    }
    flag("select_listed_options", true);
    const listing = rows.length > 0 ? `. Its options: ${listOptions(rows)}` : "; it has no options";
    throw new BrowseError(
      `No option of ${where} matches "${value}"${listing}`,
      { options: rows.map((row) => ({ value: row.value, label: row.label || row.text })) },
      "no_match",
    );
  });
}
