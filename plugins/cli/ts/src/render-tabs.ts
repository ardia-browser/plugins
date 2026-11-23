import { dumps, type JsonObject, type Value } from "./json.ts";
import { failed, type Listing, type Rendered, rendered } from "./listing.ts";
import { shown } from "./printable.ts";
import { dict, equalsInt, fixed, getOrNull, isInt, isNumber, iterateOrEmpty, number, PythonError, right, strOf, truthy } from "./py.ts";
import { flatGroups, flatTabs, groupLine, pretty, SECTIONS, shownOf, tabLine, walk } from "./render.ts";

type Heat = [boolean, number, number];

function heat(tab: JsonObject): Heat {
  const cpu = getOrNull(tab, "cpu");
  const memory = getOrNull(tab, "memory");
  const level = (value: Value) => (truthy(value) ? -number(value) : 0);
  return [cpu === null && memory === null, level(cpu), level(memory)];
}

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byHeat(found: JsonObject[]): JsonObject[] {
  const keyed = found.map((tab): [Heat, JsonObject] => [heat(tab), tab]);
  keyed.sort(([a], [b]) => Number(a[0]) - Number(b[0]) || compareNumbers(a[1], b[1]) || compareNumbers(a[2], b[2]));
  return keyed.map(([, tab]) => tab);
}

function megabytes(memory: Value): string {
  return isNumber(memory) ? `${fixed(number(memory) / 1_000_000, 0)} MB` : "-";
}

function usageLine(tab: JsonObject): string {
  const pidValue = getOrNull(tab, "pid");
  const pid = typeof pidValue === "boolean" ? (pidValue ? "1" : "0") : isInt(pidValue) ? strOf(pidValue) : "-";
  const cpuValue = getOrNull(tab, "cpu");
  const cpu = isNumber(cpuValue) ? fixed(number(cpuValue), 1) : "-";
  const memory = megabytes(getOrNull(tab, "memory"));
  return `${right(pid, 7)}  ${right(cpu, 6)}  ${right(memory, 8)}  ${tabLine(tab, "")}`;
}

function printUsage(out: string[], found: JsonObject[]): void {
  out.push(`${right("PID", 7)}  ${right("CPU%", 6)}  ${right("MEMORY", 8)}    TAB`);
  for (const tab of found) out.push(usageLine(tab));
  const anyPid = found.some((tab) => tab.has("pid") && isInt(tab.get("pid")));
  const anyMemory = found.some((tab) => tab.has("memory") && tab.get("memory") !== null);
  if (found.length > 0 && !anyPid && anyMemory) {
    out.push("(this Ardia doesn't report process ids yet, only CPU and memory; update Ardia for the PID column)");
  }
}

export function tabs(listing: Listing, tree: Value): Rendered {
  const out: string[] = [];
  if (listing.pid !== undefined) {
    const pid = listing.pid;
    const all = flatTabs(tree);
    if (!all.some((tab) => tab.has("pid") && isInt(tab.get("pid")))) {
      return failed(
        1,
        "no_pid",
        "ardia tabs: this Ardia doesn't report tab process ids yet; update Ardia (ardia tabs --usage still shows CPU and memory)",
      );
    }
    const found = byHeat(all.filter((tab) => tab.has("pid") && equalsInt(tab.get("pid"), pid)));
    if (found.length === 0) {
      return failed(
        1,
        "no_tab",
        `ardia tabs: no tab runs in process ${pid}; it may be Ardia itself, its GPU or a utility process, an extension, or a frame of another site (ardia tabs --usage lists every tab's process)`,
      );
    }
    if (listing.json) out.push(pretty(found));
    else printUsage(out, found);
    return rendered(out);
  }
  if (listing.json) out.push(pretty(listing.flat ? flatTabs(tree) : tree));
  else if (listing.usage) printUsage(out, byHeat(flatTabs(tree)));
  else if (listing.flat) {
    for (const tab of flatTabs(tree)) {
      const prefix = `${shownOf(getOrNull(tab, "window"))}  ${shownOf(getOrNull(tab, "profile"))}  `;
      out.push(tabLine(tab, prefix));
    }
  } else printTree(out, tree);
  return rendered(out);
}

function printTree(out: string[], tree: Value): void {
  for (const windowValue of iterateOrEmpty(getOrNull(tree, "windows"))) {
    const window = dict(windowValue);
    const flags = [strOf(window.has("kind") ? window.get("kind") : "normal")];
    if (truthy(window.get("focused"))) flags.push("focused");
    out.push(`window ${shownOf(window.get("id") ?? null)}  ${shown(flags.join(", "))}`);
    for (const spaceValue of iterateOrEmpty(window.get("spaces") ?? null)) {
      const space = dict(spaceValue);
      const name = [space.get("profileName"), space.get("profile")].find((value) => truthy(value)) ?? space.get("profile") ?? null;
      const shownFlag = truthy(space.get("shown")) ? "  shown" : "";
      out.push(`  ${shownOf(name)} (${shownOf(space.get("profile") ?? null)})${shownFlag}`);
      for (const [section, key] of SECTIONS) {
        const items = space.get(key) ?? null;
        if (!truthy(items)) continue;
        out.push(`    ${section}`);
        const walked: [JsonObject, number][] = [];
        let stopped: PythonError | undefined;
        try {
          walk(items, 0, walked);
        } catch (error) {
          if (!(error instanceof PythonError)) throw error;
          stopped = error;
        }
        for (const [item, depth] of walked) {
          const indent = `      ${"    ".repeat(depth)}`;
          const type = item.get("type");
          if (type === "tab") out.push(indent + tabLine(item, ""));
          else if (type === "folder") {
            const folderName = truthy(item.get("name")) ? (item.get("name") ?? "") : "";
            out.push(`${indent}  folder ${shownOf(item.get("id") ?? null)}  ${shown(dumps(folderName, "spaced"))}`);
          } else out.push(groupLine(item, `${indent}  `));
        }
        if (stopped !== undefined) {
          stopped.printed = [...out];
          throw stopped;
        }
      }
    }
  }
}

export function groups(listing: Listing, tree: Value): Rendered {
  const found = flatGroups(tree);
  if (listing.json) return rendered([pretty(found)]);
  return rendered(found.map((group) => groupLine(group, "")));
}
