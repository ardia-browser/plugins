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
