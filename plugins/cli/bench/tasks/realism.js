const INPUT_EVENTS = ["click", "keydown", "keyup", "drop", "dragend", "pointerup", "mouseup"];
const ECHO_WINDOW_MS = 50;
let lastInput = null;

for (const type of INPUT_EVENTS) {
  document.addEventListener(type, (e) => {
    const at = performance.now();
    if (!e.isTrusted && lastInput?.trusted && at - lastInput.at < ECHO_WINDOW_MS) return;
    lastInput = { type: e.type, trusted: e.isTrusted, at };
  }, true);
}

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

function eventTag() {
  if (!lastInput) return "none";
  const age = Math.round(performance.now() - lastInput.at);
  return `${lastInput.type}:${lastInput.trusted ? 1 : 0}:${age}`;
}

export async function request(path, { method = "GET", body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (payload !== undefined) {
    init.body = payload;
    if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
  }
  if (method !== "GET" && method !== "HEAD") {
    const csrf = meta("csrf-token");
    const key = meta("app-build").split("").reverse().join("");
    const nonce = crypto.getRandomValues(new Uint32Array(2)).join("-");
    const evt = eventTag();
    const url = new URL(path, location.href);
    const sig = (await digest(`${key}|${csrf}|${nonce}|${method}|${url.pathname}|${await digest(payload ?? "")}|${evt}`)).slice(0, 32);
    Object.assign(init.headers, { "X-CSRF-Token": csrf, "X-Req-Nonce": nonce, "X-Req-Sig": sig, "X-UI-Evt": evt });
  }
  return fetch(path, init);
}

const FORM_GUARD_FIELDS = new Set(["_csrf", "_nonce", "_sig", "_evt"]);

export async function signForm(form) {
  const csrf = meta("csrf-token");
  const key = meta("app-build").split("").reverse().join("");
  const nonce = crypto.getRandomValues(new Uint32Array(2)).join("-");
  const evt = eventTag();
  const method = (form.getAttribute("method") || "POST").toUpperCase();
  const action = form.getAttribute("action") || location.href;
  const url = new URL(action, location.href);
  const fields = new Map();
  for (const [k, v] of new FormData(form).entries()) {
    if (!FORM_GUARD_FIELDS.has(k) && !fields.has(k)) fields.set(k, String(v));
  }
  const pairs = [...fields.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = JSON.stringify(pairs);
  const sig = (await digest(`${key}|${csrf}|${nonce}|${method}|${url.pathname}|${await digest(payload)}|${evt}`)).slice(0, 32);
  const snapshot = document.createElement("form");
  snapshot.method = method;
  snapshot.action = action;
  snapshot.style.display = "none";
  for (const [name, value] of pairs) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    snapshot.appendChild(input);
  }
  const vals = { _csrf: csrf, _nonce: nonce, _sig: sig, _evt: evt };
  for (const [name, value] of Object.entries(vals)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    snapshot.appendChild(input);
  }
  return snapshot;
}
