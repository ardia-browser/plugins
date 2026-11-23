declare module "bun:test" {
  export function test(name: string, body: () => void | Promise<void>, timeout: number): void;
  export function beforeAll(body: () => void | Promise<void>, timeout?: number): void;
  export function afterAll(body: () => void | Promise<void>, timeout?: number): void;
  export function describe(name: string, body: () => void): void;
}

declare module "bun:ffi" {
  export const FFIType: { readonly i32: number; readonly u32: number; readonly i64: number; readonly u64: number; readonly ptr: number };
  export type Pointer = number & { readonly pointer: unique symbol };
  export function ptr(view: ArrayBufferView): Pointer;
  export function dlopen<Fns extends Record<string, { args: number[]; returns: number }>>(
    path: string,
    symbols: Fns,
  ): { symbols: { [Name in keyof Fns]: (...args: (number | bigint | Pointer | null)[]) => number }; close(): void };
}
