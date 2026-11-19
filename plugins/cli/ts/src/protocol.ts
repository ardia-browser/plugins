export const PROTOCOL = 4;
export const MIN_APP_PROTOCOL = 1;
export const SOCKET_FILE = "ArdiaControl.sock";
export const MAX_LINE_BYTES = 1024 * 1024;

export type ErrorCode =
  | "bad_request"
  | "unknown_method"
  | "unknown_command"
  | "refused"
  | "no_window"
  | "failed"
  | "unsupported_protocol";

export type RequestId = number | string;

export type Caller = { name: string; app?: string };

export type HelloParams = { caller: Caller; protocol: number };

export type HelloResult = {
  app: "Ardia";
  version?: string;
  protocol?: number;
  minClientProtocol?: number;
};

export type Methods = {
  hello: { params: HelloParams; result: HelloResult };
  caller: { params: undefined; result: unknown };
  windows: { params: undefined; result: unknown };
  commands: { params: undefined; result: unknown };
  workspace: { params: Record<string, unknown>; result: unknown };
  run: { params: Record<string, unknown>; result: unknown };
  apply: { params: Record<string, unknown>; result: unknown };
  subscribe: { params: Record<string, unknown>; result: unknown };
};

export type Method = keyof Methods;

export type Request<M extends Method = Method> = Methods[M]["params"] extends undefined
  ? { id: RequestId; method: M }
  : { id: RequestId; method: M; params: Methods[M]["params"] };

export type MethodError = { code: ErrorCode | (string & {}); message: string };

export type Reply<M extends Method = Method> =
  | { id: RequestId; result: Methods[M]["result"] }
  | { id: RequestId; error: MethodError };

export type EventLine = { event: string } & Record<string, unknown>;
