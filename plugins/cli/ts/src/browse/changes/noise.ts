export const STYLE_THROTTLE_MS = 200;
export const REACTION_EXPIRY_MS = 3000;
export const QUIET_WATCH = "ardiaBrowseQuietWatch";

export const MUTATION_NOISE_FILTER = `(record, seen, now) => {
  if (record.type === "attributes") {
    const name = record.attributeName;
    const target = record.target;
    const value = target && target.getAttribute ? target.getAttribute(name) : null;
    if (value === record.oldValue) return false;
    if (name === "style") {
      const last = seen.get(target);
      if (last !== undefined && now - last < ${STYLE_THROTTLE_MS}) return false;
      seen.set(target, now);
    }
    return true;
  }
  if (record.type === "characterData") return !record.target || record.target.data !== record.oldValue;
  return (record.addedNodes ? record.addedNodes.length : 0) > 0 || (record.removedNodes ? record.removedNodes.length : 0) > 0;
}`;

const STOP_QUIET = `const stopQuiet = (watch) => {
    watch.observer.disconnect();
    clearTimeout(watch.timer);
    watch.field.removeEventListener("input", watch.onInput, true);
    watch.field.removeEventListener("keydown", watch.onInput, true);
    if (globalThis.${QUIET_WATCH} === watch) globalThis.${QUIET_WATCH} = null;
  };`;

export const WATCH_REACTION_SOURCE = `(given, id) => {
  const api = ardiaBrowse;
  const field = given || document.activeElement;
  if (!api.filterField(field)) return false;
  ${STOP_QUIET}
  const keep = ${MUTATION_NOISE_FILTER};
  if (!Object.getOwnPropertyDescriptor(globalThis, "${QUIET_WATCH}")) Object.defineProperty(globalThis, "${QUIET_WATCH}", { value: null, writable: true, enumerable: false });
  if (globalThis.${QUIET_WATCH}) stopQuiet(globalThis.${QUIET_WATCH});
  const watch = { id, field, lastInput: performance.now(), last: 0, observer: null, timer: 0, onInput: null, stop: null };
  watch.stop = () => stopQuiet(watch);
  const expire = () => {
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => { if (globalThis.${QUIET_WATCH} === watch) stopQuiet(watch); }, ${REACTION_EXPIRY_MS});
  };
  watch.onInput = () => { watch.lastInput = performance.now(); expire(); };
  field.addEventListener("input", watch.onInput, true);
  field.addEventListener("keydown", watch.onInput, true);
  const results = api.popupIds(field).map((name) => document.getElementById(name)).filter(Boolean);
  const relevant = (record) => !field.contains(record.target)
    && (!results.length || results.some((node) => !node.isConnected || node === record.target || node.contains(record.target)));
  const seen = new WeakMap();
  watch.observer = new MutationObserver((records) => {
    const now = performance.now();
    if (records.some((record) => relevant(record) && keep(record, seen, now))) watch.last = now;
  });
  const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, characterDataOldValue: true };
  watch.observer.observe(document.documentElement, options);
  for (const frame of document.querySelectorAll("iframe, frame")) {
    try {
      const inner = frame.contentDocument;
      if (inner && inner.documentElement) watch.observer.observe(inner.documentElement, options);
    } catch (error) {}
  }
  expire();
  globalThis.${QUIET_WATCH} = watch;
  return true;
}`;

export const WATCH_REACTION = `(el, id) => (${WATCH_REACTION_SOURCE})(el, id)`;
export const WATCH_REACTION_FOCUSED = `(id) => (${WATCH_REACTION_SOURCE})(null, id)`;

export const REACTION_STATE = `(id) => {
  const watch = globalThis.${QUIET_WATCH};
  if (!watch || watch.id !== id) return null;
  const now = performance.now();
  const busy = watch.field.getAttribute("aria-busy") === "true" || Boolean(document.querySelector("[aria-busy=true]"));
  return { sinceInput: now - watch.lastInput, sinceLast: watch.last > watch.lastInput ? now - watch.last : null, busy };
}`;

export const UNWATCH_REACTION = `(id) => {
  const watch = globalThis.${QUIET_WATCH};
  if (watch && watch.id === id) watch.stop();
  return true;
}`;
