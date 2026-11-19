import { floatRepr } from "../json.ts";
import { pyInt, PyException } from "../pylib/str.ts";

export function pyError(type: string, message: string): Error {
  const error = new Error(message);
  error.name = type;
  return error;
}

export function pyIntArg(text: string): number {
  try {
    return Number(pyInt(text));
  } catch (error) {
    if (error instanceof PyException) throw pyError(error.type, error.message);
    throw error;
  }
}

type RawJson = (text: string) => unknown;

export function pyFloat(value: number): unknown {
  const raw = (JSON as unknown as { rawJSON?: RawJson }).rawJSON;
  return raw && Number.isFinite(value) ? raw(floatRepr(value)) : value;
}
