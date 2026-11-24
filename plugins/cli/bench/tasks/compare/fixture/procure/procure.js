import { request } from "/realism.js";

const view = document.getElementById("view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LABELS = { vendor: "Vendor", website: "Website", tier: "Plan tier", cycle: "Billing cycle", seats: "Seats", annual_total: "Annual total (USD)", soc2_date: "SOC 2 Type II report date", eu_residency: "EU data residency", eu_region: "EU region", justification: "Justification" };

function go(path) {
  history.pushState({}, "", path);
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-view], a[data-go]");
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute("href")); }
});
window.addEventListener("popstate", route);

function summary(req) {
  return `<dl class="summary">${Object.entries(LABELS).filter(([k]) => req[k]).map(([k, label]) => `<dt>${label}</dt><dd>${esc(k === "annual_total" ? `$${req[k]}` : req[k])}</dd>`).join("")}</dl>`;
}

function renderForm() {
  document.title = "New purchase request · Northwind Procurement";
  view.innerHTML = "";
  view.appendChild(document.getElementById("form-template").content.cloneNode(true));
  const form = document.getElementById("request-form");
  const region = document.getElementById("region-field");
  const syncRegion = () => { region.hidden = form.querySelector('input[name="eu_residency"]:checked')?.value !== "yes"; };
  form.addEventListener("change", syncRegion);
  form.addEventListener("reset", () => setTimeout(syncRegion, 0));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelectorAll(".err").forEach((el) => { el.textContent = ""; });
    form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    const errorEl = document.getElementById("form-error");
    errorEl.hidden = true;
    const body = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const res = await request("/api/requests", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        for (const [field, message] of Object.entries(data.fields || {})) {
          const slot = form.querySelector(`[data-err="${field}"]`);
          if (slot) slot.textContent = message;
          form.querySelector(`[name="${field}"]`)?.classList.add("invalid");
        }
        errorEl.textContent = data.error || "Couldn't submit the request";
        errorEl.hidden = false;
        return;
      }
      renderDone(data.request);
    } finally { button.disabled = false; }
  });
}

function renderDone(req) {
  history.replaceState({}, "", "/requests");
  setActive("requests");
  view.innerHTML = `<header class="page-head"><div><p class="crumb">Requests / ${esc(req.id)}</p><h1>Request submitted</h1></div><span class="step">${esc(req.status)}</span></header>
    <div class="done"><h2>✓ ${esc(req.id)} is with Finance</h2><p>You'll get an email when it's approved. You can submit a corrected request if something's wrong; Finance reviews the latest one.</p>${summary(req)}
    <a class="btn secondary" href="/new" data-go>Submit another request</a> <a class="btn ghost" href="/requests" data-go>See all requests</a></div>`;
}

async function renderList() {
  document.title = "My requests · Northwind Procurement";
  const reqs = await (await fetch("/api/requests", { credentials: "same-origin" })).json();
  view.innerHTML = `<header class="page-head"><div><p class="crumb">Requests</p><h1>My requests</h1></div><a class="btn primary" href="/new" data-go>New request</a></header>
    ${reqs.length ? `<table class="reqs"><thead><tr><th>ID</th><th>Vendor</th><th>Plan</th><th>Seats</th><th>Annual total</th><th>Status</th></tr></thead><tbody>${reqs.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.vendor)}</td><td>${esc(r.tier)} · ${esc(r.cycle)}</td><td>${esc(r.seats)}</td><td>$${esc(r.annual_total)}</td><td><span class="status">${esc(r.status)}</span></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No requests yet. <a href="/new" data-go>Start one</a>.</div>`}`;
}

function setActive(name) {
  document.querySelectorAll("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
}

function route() {
  const path = location.pathname.replace(/\/$/, "");
  if (path === "/requests") { setActive("requests"); renderList(); }
  else { setActive("new"); renderForm(); }
}

route();
