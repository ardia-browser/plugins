declare module "bun:ffi" {
  export type Pointer = number;
  export const FFIType: { readonly ptr: "ptr"; readonly u64: "u64"; readonly i32: "i32"; readonly u64_fast: "u64_fast" };
  export const read: {
    ptr(pointer: Pointer, offset?: number): Pointer;
    i32(pointer: Pointer, offset?: number): number;
  };
  export function toBuffer(pointer: Pointer, offset: number, length: number): Buffer;
  export function ptr(view: ArrayBufferView): Pointer;
  type Signature = { args: readonly string[]; returns: string };
  export function dlopen<T extends Record<string, Signature>>(
    path: string,
    symbols: T,
  ): { symbols: { [K in keyof T]: (...args: unknown[]) => T[K]["returns"] extends "ptr" ? Pointer | null : number | bigint }; close(): void };
}
