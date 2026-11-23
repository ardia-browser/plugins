import { codePoints } from "../../pystr.ts";

export const MAX_TOOLS = 64;
export const MAX_DESCRIPTION = 200;
export const MAX_OUTPUT = 20000;
export const SECTION_TOOLS = 12;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/u;
const CONSEQUENTIAL_WORDS = new Set([
  "delete", "remove", "destroy", "drop", "erase", "purge", "wipe", "empty", "clear", "pay", "purchase", "buy", "checkout", "order", "book", "reserve",
  "send", "post", "publish", "submit", "transfer", "withdraw", "cancel", "unsubscribe", "close", "archive", "revoke", "ban", "block", "refund", "charge",
  "sign", "approve", "reject", "invite", "share", "merge", "deploy", "reset", "update", "edit", "create", "add", "save", "change", "move", "rename",
  "upload", "logout", "leave", "unlink", "disable", "enable", "set", "write", "apply", "confirm", "accept", "decline", "follow", "unfollow", "like", "reply", "comment",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export type ToolParam = { name: string; type: string; required: boolean; description: string };
export type SiteTool = {
  name: string;
  description: string;
  params: ToolParam[];
  readOnly: boolean;
  consequential: boolean;
  source: string;
  schema: Record<string, unknown> | null;
  fingerprint: string;
};

function clip(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/gu, " ").trim();
  const points = codePoints(flat);
  return points.length <= limit ? flat : `${points.slice(0, limit - 1).join("")}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function schemaOf(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      return record(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return record(raw);
}

function typeOf(schema: Record<string, unknown> | null): string {
  if (schema === null) return "any";
  const kind = schema["type"];
  if (typeof kind === "string" && TYPES.has(kind)) return kind;
  if (Array.isArray(kind)) {
    const kinds = kind.filter((item): item is string => typeof item === "string" && TYPES.has(item));
    if (kinds.length > 0) return kinds.join("|");
  }
  if (Array.isArray(schema["enum"])) return schema["enum"].slice(0, 6).map((item) => JSON.stringify(item)).join("|");
  return "any";
}

export function paramsOf(schema: Record<string, unknown> | null): ToolParam[] {
  const properties = record(schema?.["properties"]);
  if (properties === null) return [];
  const required = new Set(Array.isArray(schema?.["required"]) ? (schema?.["required"] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties)
    .slice(0, 24)
    .filter(([name]) => NAME.test(name))
    .map(([name, inner]) => ({ name, type: typeOf(record(inner)), required: required.has(name), description: clip(record(inner)?.["description"], 80) }));
}

export function isConsequential(name: string, annotations: Record<string, unknown> | null): boolean {
  if (annotations !== null && (annotations["destructiveHint"] === true || annotations["consequential"] === true || annotations["requiresUserConfirmation"] === true)) return true;
  return wordsOf(name).some((word) => CONSEQUENTIAL_WORDS.has(word));
}

export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word)
    .map((word) => word.toLowerCase());
}

export function normalizeTools(raw: unknown): SiteTool[] {
  const found = record(raw);
  const list = Array.isArray(found?.["tools"]) ? (found?.["tools"] as unknown[]) : [];
  const out: SiteTool[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const tool = record(item);
    const name = typeof tool?.["name"] === "string" ? (tool["name"] as string).trim() : "";
    if (tool === null || !NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const annotations = schemaOf(tool["annotations"]);
    const schema = schemaOf(tool["inputSchema"]);
    out.push({
      name,
      description: clip(tool["description"], MAX_DESCRIPTION),
      params: paramsOf(schema),
      readOnly: annotations?.["readOnlyHint"] === true,
      consequential: isConsequential(name, annotations),
      source: clip(tool["source"], 40) || "page",
      schema,
      fingerprint: typeof tool["fingerprint"] === "string" ? (tool["fingerprint"] as string) : "",
    });
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

export function signatureOf(tool: SiteTool): string {
  const params = tool.params.map((param) => `${param.name}${param.required ? "" : "?"}: ${param.type}`).join(", ");
  const marks = [tool.consequential ? "[CONSEQUENTIAL]" : "", tool.readOnly ? "[page says read-only]" : ""].filter((mark) => mark).join(" ");
  return `${tool.name}(${params})${marks ? ` ${marks}` : ""}`;
}

export function siteToolsSection(tools: readonly SiteTool[], limit = SECTION_TOOLS): string | null {
  if (tools.length === 0) return null;
  const shown = tools.slice(0, limit).map((tool) => `${signatureOf(tool)}${tool.description ? ` - ${clip(tool.description, 80)}` : ""}`);
  const more = tools.length > limit ? `; … ${tools.length - limit} more: \`ardia browse tools\`` : "";
  return `# site tools [UNTRUSTED names and descriptions from the page] (\`ardia browse tool <name> '{json}'\`): ${shown.join("; ")}${more}`;
}

export function listingText(tools: readonly SiteTool[], origin: string): string {
  if (tools.length === 0) return `No site tools on ${origin}: the page registers no WebMCP tools (document.modelContext, navigator.modelContext or form[toolname])`;
  const lines = [`# site tools on ${origin} [UNTRUSTED names and descriptions from the page]`];
  for (const tool of tools) {
    lines.push(`${signatureOf(tool)}${tool.description ? `\n    ${tool.description}` : ""}`);
    for (const param of tool.params) if (param.description) lines.push(`    ${param.name}: ${param.description}`);
  }
  lines.push("→ ardia browse tool <name> '{\"arg\": \"value\"}' --yes (every call runs the page's own code, so it needs --yes; ask the user first for a [CONSEQUENTIAL] one)");
  return lines.join("\n");
}

function matches(type: string, value: unknown): boolean {
  if (type === "any" || type.includes('"')) return true;
  return type.split("|").some((kind) => {
    if (kind === "string") return typeof value === "string";
    if (kind === "number") return typeof value === "number" && Number.isFinite(value);
    if (kind === "integer") return typeof value === "number" && Number.isInteger(value);
    if (kind === "boolean") return typeof value === "boolean";
    if (kind === "object") return record(value) !== null;
    if (kind === "array") return Array.isArray(value);
    if (kind === "null") return value === null;
    return true;
  });
}

export function checkArgs(tool: SiteTool, args: unknown): string[] {
  const given = record(args);
  if (given === null) return ["the arguments must be a JSON object"];
  const problems: string[] = [];
  for (const param of tool.params) {
    if (!Object.hasOwn(given, param.name)) {
      if (param.required) problems.push(`${param.name} is required (${param.type})`);
      continue;
    }
    if (!matches(param.type, given[param.name])) problems.push(`${param.name} should be ${param.type}`);
  }
  const properties = record(tool.schema?.["properties"]);
  if (properties !== null && tool.schema?.["additionalProperties"] === false) {
    for (const key of Object.keys(given)) if (!Object.hasOwn(properties, key)) problems.push(`${key} isn't one of its arguments`);
  }
  return problems;
}

export function renderOutput(value: unknown): string {
  const found = record(value);
  const content = found?.["content"];
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      const part = record(item);
      if (part === null) return "";
      if (typeof part["text"] === "string") return part["text"];
      if (part["type"] === "image") return "[an image]";
      return JSON.stringify(part);
    });
    return capped(parts.filter((part) => part).join("\n")) || "(no output)";
  }
  if (typeof value === "string") return capped(value);
  if (value === null || value === undefined) return "(no output)";
  return capped(JSON.stringify(value, null, 1));
}

function capped(text: string): string {
  const points = codePoints(text);
  return points.length <= MAX_OUTPUT ? text : `${points.slice(0, MAX_OUTPUT - 1).join("")}…`;
}

export function failedOutput(value: unknown): boolean {
  return record(value)?.["isError"] === true;
}

export const COLLECT = `async (only) => {
  const found = [];
  const seen = new Set();
  const plain = (value) => { try { return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value)); } catch { return null; } };
  const within = (promise) => Promise.race([promise, new Promise((done) => setTimeout(() => done(null), 1500))]);
  const add = (tool, source, call) => {
    if (!tool || typeof tool !== "object" || found.length >= ${MAX_TOOLS}) return;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name || seen.has(name)) return;
    seen.add(name);
    const entry = { name, description: typeof tool.description === "string" ? tool.description.slice(0, 600) : "", inputSchema: plain(tool.inputSchema ?? tool.input_schema ?? tool.parameters ?? null), annotations: plain(tool.annotations ?? null), source };
    entry.fingerprint = JSON.stringify([entry.name, entry.description, entry.inputSchema, entry.annotations, entry.source]);
    found.push({ entry, call });
  };
  const itemsOf = async (holder) => {
    for (const key of ["listTools", "getTools"]) {
      if (typeof holder[key] !== "function") continue;
      const got = await within(holder[key]());
      return Array.isArray(got) ? got : got && Array.isArray(got.tools) ? got.tools : [];
    }
    const tools = holder.tools ?? holder.registeredTools;
    if (tools instanceof Map) return [...tools].map(([key, item]) => (item && typeof item === "object" && !item.name ? { ...item, name: String(key) } : item));
    if (Array.isArray(tools)) return tools;
    if (tools && typeof tools === "object") return Object.entries(tools).map(([key, item]) => (item && typeof item === "object" && !item.name ? { ...item, name: key } : item));
    return [];
  };
  let nav = null;
  try { nav = navigator; } catch {}
  const testing = nav && nav.modelContextTesting;
  if (testing && (!only || only === "navigator.modelContextTesting")) {
    try {
      for (const item of await itemsOf(testing)) {
        add(item, "navigator.modelContextTesting", async (name, args) => {
          const result = await testing.executeTool(name, JSON.stringify(args));
          if (typeof result !== "string") return result;
          try { return JSON.parse(result); } catch { return result; }
        });
      }
    } catch {}
  }
  for (const [label, holder] of [["document.modelContext", document.modelContext], ["navigator.modelContext", nav && nav.modelContext]]) {
    if (!holder || (typeof holder !== "object" && typeof holder !== "function") || (only && only !== label)) continue;
    try {
      for (const item of await itemsOf(holder)) {
        add(item, label, async (name, args) => {
          if (item && typeof item.execute === "function") {
            const client = { requestUserInteraction: async () => { throw new Error("this tool asked for user interaction, which the ardia command doesn't give"); } };
            return item.execute(args, client);
          }
          for (const key of ["executeTool", "callTool", "invokeTool"]) if (typeof holder[key] === "function") return holder[key](name, args);
          throw new Error("the page registered this tool with nothing to call");
        });
      }
    } catch {}
  }
  if (!only || only === "form") {
    try {
      for (const form of document.querySelectorAll("form[toolname]")) {
        const properties = {};
        const required = [];
        for (const field of form.elements) {
          if (!field.name || ["submit", "button", "reset", "hidden", "file", "password"].includes(field.type)) continue;
          const type = field.type === "number" || field.type === "range" ? "number" : field.type === "checkbox" ? "boolean" : "string";
          properties[field.name] = { type, description: field.getAttribute("toolparamdescription") || field.getAttribute("aria-label") || field.placeholder || "" };
          if (field.required) required.push(field.name);
        }
        const tool = { name: form.getAttribute("toolname"), description: form.getAttribute("tooldescription") || "", inputSchema: { type: "object", properties, required }, annotations: { readOnlyHint: (form.getAttribute("method") || "get").toLowerCase() === "get" } };
        add(tool, "form", async (name, args) => {
          for (const [key, value] of Object.entries(args || {})) {
            const field = form.elements.namedItem(key);
            if (!field || field.type === "file" || field.type === "password") continue;
            if (field.type === "checkbox") field.checked = Boolean(value);
            else field.value = String(value);
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
          return { content: [{ type: "text", text: "The form was submitted" }] };
        });
      }
    } catch {}
  }
  return found;
}`;

export const PROBE = `(async () => ({ tools: (await (${COLLECT})(null)).map((item) => item.entry) }))()`;

export function invokeExpression(name: string, args: unknown, source: string, fingerprint: string): string {
  return `(async (name, args, source, fingerprint) => {
  const plain = (value) => { try { return value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { return String(value); } };
  const found = (await (${COLLECT})(source)).find((item) => item.entry.name === name);
  if (!found) return { missing: true };
  if (found.entry.fingerprint !== fingerprint) return { changed: true };
  return { via: source, result: plain(await found.call(name, args)) };
})(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})}, ${JSON.stringify(source)}, ${JSON.stringify(fingerprint)})`;
}
