export const SENT_METHODS: ReadonlySet<string> = new Set([
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Page.enable",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Page.handleJavaScriptDialog",
  "Page.getLayoutMetrics",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOM.getAttributes",
  "DOM.getOuterHTML",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Ardia.dispatchClick",
]);

export const CLICK_METHOD = "Ardia.dispatchClick";
export const INPUT_METHODS: ReadonlySet<string> = new Set(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", CLICK_METHOD]);

export const FORBIDDEN_PREFIXES: readonly string[] = ["Runtime.", "Debugger."];
export const FORBIDDEN_METHODS: ReadonlySet<string> = new Set([
  "DOM.resolveNode",
  "DOM.performSearch",
  "DOM.getSearchResults",
  "DOM.discardSearchResults",
  "Page.createIsolatedWorld",
  "Page.addScriptToEvaluateOnNewDocument",
  "Input.dispatchDragEvent",
  "Input.setInterceptDrags",
  "Input.dispatchTouchEvent",
  "Input.emulateTouchFromMouseEvent",
]);

export const KEY_COMMANDS: ReadonlySet<string> = new Set([
  "selectAll",
  ...["moveToBeginningOfLine", "moveToEndOfLine", "moveToBeginningOfDocument", "moveToEndOfDocument", "moveLeft", "moveRight", "moveUp", "moveDown", "moveWordLeft", "moveWordRight"].flatMap(
    (name) => [name, `${name}AndModifySelection`],
  ),
  "deleteBackward",
  "deleteForward",
  "deleteWordBackward",
  "deleteWordForward",
  "insertNewline",
  "insertTab",
]);

const MOUSE_TYPES = new Set(["mouseMoved", "mouseWheel"]);
const CLICK_BUTTONS = new Set(["left", "right"]);
const CLICK_COUNTS = new Set([1, 2]);

export class PluginPolicy extends Error {
  override readonly name = "PluginPolicy";
}

export function forbidden(method: string): boolean {
  return FORBIDDEN_METHODS.has(method) || FORBIDDEN_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function checkKey(params: Record<string, unknown>): void {
  if ("nativeVirtualKeyCode" in params || "isSystemKey" in params) throw new PluginPolicy("a plugin key event carries no nativeVirtualKeyCode or isSystemKey");
  const commands = params["commands"];
  if (commands === undefined) return;
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || !KEY_COMMANDS.has(command))) {
    throw new PluginPolicy(`a plugin key event's commands must come from the editing allowlist, not ${JSON.stringify(commands)}`);
  }
}

export function mouseViolation(params: Record<string, unknown>): string | null {
  const type = params["type"];
  if (typeof type !== "string" || !MOUSE_TYPES.has(type)) return `a plugin mouse event is a buttonless move or a wheel, not ${String(type)} (clicks go through ${CLICK_METHOD})`;
  if ((params["button"] ?? "none") !== "none" || Number(params["buttons"] ?? 0) !== 0) return "a plugin mouse event never holds a button";
  return null;
}

function checkMouse(params: Record<string, unknown>): void {
  const bad = mouseViolation(params);
  if (bad !== null) throw new PluginPolicy(bad);
}

function checkClick(params: Record<string, unknown>): void {
  const { x, y, button, clickCount, modifiers } = params;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw new PluginPolicy(`${CLICK_METHOD} takes a finite x and y`);
  if (typeof button !== "string" || !CLICK_BUTTONS.has(button)) throw new PluginPolicy(`${CLICK_METHOD} clicks the left or right button, not ${String(button)}`);
  if (typeof clickCount !== "number" || !CLICK_COUNTS.has(clickCount)) throw new PluginPolicy(`${CLICK_METHOD} takes a clickCount of 1 or 2`);
  if (typeof modifiers !== "number" || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) throw new PluginPolicy(`${CLICK_METHOD} takes modifier bits 0 to 15`);
}

export function checkRequest(method: string, params: Record<string, unknown>): void {
  if (forbidden(method) || !SENT_METHODS.has(method)) throw new PluginPolicy(`plugin mode never sends ${method}`);
  if ("objectId" in params || "executionContextId" in params || "contextId" in params) throw new PluginPolicy(`plugin mode never sends ${method} with a script handle`);
  if (method === "Input.dispatchKeyEvent") checkKey(params);
  else if (method === "Input.dispatchMouseEvent") checkMouse(params);
  else if (method === CLICK_METHOD) checkClick(params);
  else if (method === "Input.insertText" && typeof params["text"] !== "string") throw new PluginPolicy("Input.insertText takes text");
}
