import { readFileSync } from "node:fs";
import { BLOBS } from "./cases.ts";
import { dumps, isObject, loads, type Py, type PyObject } from "./pyjson.ts";

let store: PyObject | undefined;

export function blobStore(): PyObject {
  if (store === undefined) {
    const loaded = loads(readFileSync(BLOBS, "utf8"));
    store = isObject(loaded) ? loaded : new Map();
  }
  return store;
}

function stored(name: Py | undefined): Py {
  if (typeof name !== "string" || !blobStore().has(name)) throw new Error(`no blob ${JSON.stringify(name)}`);
  return blobStore().get(name)!;
}

export function decodeBlob(value: Py | undefined): Buffer {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (isObject(value) && value.has("blob")) return decodeBlob(stored(value.get("blob")));
  if (isObject(value) && value.has("text")) return Buffer.from(String(value.get("text")), "utf8");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (isObject(value) && value.has("base64")) return Buffer.from(String(value.get("base64")), "base64");
  if (isObject(value) && value.has("json")) return Buffer.from(dumps(value.get("json")!), "utf8");
  if (isObject(value) && value.has("parts")) {
    const parts = value.get("parts");
    if (!Array.isArray(parts)) throw new Error("blob parts is a list");
    return Buffer.concat(parts.map((part) =>
      isObject(part) && part.has("repeat") ? Buffer.from(String(part.get("repeat")).repeat(Number(part.get("times"))), "utf8") : decodeBlob(part)));
  }
  throw new Error(`not a blob: ${dumps(value)}`);
}

export type Places = Map<string, string>;

export function expandText(value: string, places: Places): string {
  for (const [name, place] of places) value = value.split(`{${name}}`).join(place);
  return value;
}

export function expand(value: Py, places: Places): Py {
  if (typeof value === "string") return expandText(value, places);
  if (Array.isArray(value)) return value.map((item) => expand(item, places));
  if (isObject(value)) return new Map([...value].map(([key, item]) => [key, expand(item, places)]));
  return value;
}

export function fileBytes(spec: Py, places: Places): Buffer {
  if (isObject(spec) && spec.has("blob")) return fileBytes(stored(spec.get("blob")), places);
  if (typeof spec === "string") return Buffer.from(expandText(spec, places), "utf8");
  if (isObject(spec) && spec.has("text")) return Buffer.from(expandText(String(spec.get("text")), places), "utf8");
  return decodeBlob(spec);
}
