declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean; safeIntegers?: boolean; strict?: boolean });
    run(sql: string, ...params: unknown[]): void;
    query(sql: string): { values(...params: unknown[]): unknown[][]; all(...params: unknown[]): unknown[] };
    serialize(): Uint8Array;
    close(throwOnError?: boolean): void;
  }
}
