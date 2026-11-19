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
]);

export const INPUT_METHODS: ReadonlySet<string> = new Set(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"]);

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

const MOUSE_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const MOUSE_BUTTONS = new Set(["none", "left", "right"]);

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

function checkMouse(params: Record<string, unknown>): void {
  const type = params["type"];
  if (typeof type !== "string" || !MOUSE_TYPES.has(type)) throw new PluginPolicy(`a plugin mouse event is pressed, released, moved or wheel, not ${String(type)}`);
  const button = params["button"] ?? "none";
  if (typeof button !== "string" || !MOUSE_BUTTONS.has(button)) throw new PluginPolicy(`a plugin mouse event uses the left or right button, not ${String(button)}`);
  if (type === "mouseMoved" && (button !== "none" || Number(params["buttons"] ?? 0) !== 0)) throw new PluginPolicy("plugins can't drag: a move never holds a button");
}

export function checkRequest(method: string, params: Record<string, unknown>): void {
  if (forbidden(method) || !SENT_METHODS.has(method)) throw new PluginPolicy(`plugin mode never sends ${method}`);
  if ("objectId" in params || "executionContextId" in params || "contextId" in params) throw new PluginPolicy(`plugin mode never sends ${method} with a script handle`);
  if (method === "Input.dispatchKeyEvent") checkKey(params);
  else if (method === "Input.dispatchMouseEvent") checkMouse(params);
  else if (method === "Input.insertText" && typeof params["text"] !== "string") throw new PluginPolicy("Input.insertText takes text");
}
