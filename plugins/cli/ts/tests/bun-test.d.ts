declare module "bun:test" {
  type Spy = { mockRestore(): void; mockImplementation(body: (...args: never[]) => unknown): Spy };
  type Matchers = { toBe(value: unknown): void; toHaveBeenCalledTimes(count: number): void };
  export function test(name: string, body: () => void | Promise<void>): void;
  export function afterEach(body: () => void): void;
  export function expect(value: unknown): Matchers;
  export function spyOn<T extends object>(target: T, name: keyof T & string): Spy;
}
