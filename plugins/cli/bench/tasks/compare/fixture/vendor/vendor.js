const PROCUREMENT_PORTAL = "http://127.0.0.1:8892/";
const page = document.body.dataset.page;
const usd = (n) => `$${n.toLocaleString("en-US")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PLANS = [
  { id: "starter", name: "Starter", blurb: "For small teams getting organised.", monthly: [12, 11], annual: [10, 9], bullets: ["Unlimited projects", "Guest access", "Email support"] },
  { id: "team", name: "Team", blurb: "Everything a growing team needs.", monthly: [24, 21], annual: [20, 17], bullets: ["Everything in Starter", "Single sign-on", "Timeline and workload views"], popular: true },
  { id: "business", name: "Business", blurb: "Controls for security-minded companies.", monthly: [39, 34], annual: [32, 28], bullets: ["Everything in Team", "Audit logs", "SCIM provisioning"] },
  { id: "enterprise", name: "Enterprise", blurb: "Custom contracts and dedicated support.", contact: true, bullets: ["Everything in Business", "Custom data retention", "Dedicated success manager"] },
];
const VOLUME_FROM = 11;
const MATRIX = [
  { feature: "Single sign-on (SSO)", cells: ["no", "yes", "yes", "yes"], detail: ["Not available.", "SAML 2.0 and OIDC with Okta, Entra ID and Google Workspace.", "SAML 2.0 and OIDC, plus enforced SSO for all members.", "Everything in Business, plus multiple identity providers."] },
  { feature: "Audit logs", cells: ["no", "partial:Activity feed", "yes", "yes"], detail: ["Not available.", "A 7-day activity feed in the app. It isn't an audit log: it can't be filtered by actor or exported.", "Full audit log of admin and member events, 12-month retention, CSV export and SIEM streaming.", "Custom retention up to 7 years."] },
  { feature: "EU data residency", cells: ["no", "no", "yes", "yes"], detail: ["Data is stored in the US.", "Data is stored in the US.", "Pin your workspace to our EU region. See Security for details.", "EU region, plus a dedicated tenant on request."] },
  { feature: "SCIM provisioning", cells: ["no", "no", "yes", "yes"], detail: ["—", "—", "Okta, Entra ID and OneLogin.", "Any SCIM 2.0 provider."] },
  { feature: "API rate limit", cells: ["text:60 / min", "text:300 / min", "text:1,000 / min", "text:Custom"], detail: ["Per workspace.", "Per workspace.", "Per workspace, burst to 2,000.", "Negotiated."] },
  { feature: "Support", cells: ["text:Email", "text:Email + chat", "text:Priority, 4 h", "text:Dedicated, 1 h"], detail: ["Business days.", "Business days.", "24/5 with a 4-hour first response.", "24/7 with a named manager."] },
];
const CHANGELOG = [
  { date: "2026-11-02", tag: "Feature", title: "Audit log export to Amazon S3", body: "Business and Enterprise admins can now stream audit events to an S3 bucket every five minutes." },
  { date: "2026-10-21", tag: "Improvement", title: "Faster timeline view", body: "Large timelines render up to 3x faster." },
  { date: "2026-10-14", tag: "Security", title: "SOC 2 Type II report now available", body: "Our SOC 2 Type II report was issued on October 14, 2026 by Brightline Assurance LLP. It covers the audit period September 1, 2025 to August 31, 2026. Request a copy under NDA from the Security page." },
  { date: "2026-09-22", tag: "Security", title: "EU data residency moves to Frankfurt", body: "New and existing EU workspaces are now hosted in our Frankfurt region (eu-central-1). The Dublin region (eu-west-1) is deprecated: it stops accepting data on January 31, 2027, and remaining workspaces are migrated automatically." },
  { date: "2026-07-08", tag: "Feature", title: "SCIM provisioning for Business", body: "Provision and deprovision members from Okta, Entra ID and OneLogin." },
  { date: "2026-05-19", tag: "Pricing", title: "Volume pricing for every plan", body: "Seats from the 11th onward are now billed at a lower per-seat rate on every self-serve plan." },
  { date: "2026-03-30", tag: "Improvement", title: "Keyboard shortcuts everywhere", body: "Press ? anywhere to see them." },
  { date: "2025-06-10", tag: "Security", title: "EU data residency launches in Dublin", body: "Business workspaces can now keep data in our Dublin region (eu-west-1)." },
  { date: "2025-03-03", tag: "Security", title: "SOC 2 Type I report available", body: "Our first SOC 2 Type I report was issued on March 3, 2025." },
];

function chrome() {
  const links = [["/", "Product"], ["/pricing", "Pricing"], ["/security", "Security"], ["/changelog", "Changelog"]];
  document.body.insertAdjacentHTML("afterbegin", `<header class="nav"><div class="nav-inner"><a class="logo" href="/"><i></i>Vantage</a>
    ${links.map(([href, label]) => `<a class="item ${location.pathname === href ? "active" : ""}" href="${href}">${label}</a>`).join("")}
    <div class="cta"><a class="btn" href="/pricing">Log in</a><a class="btn primary" href="/pricing">Start free trial</a></div></div></header>`);
  document.body.insertAdjacentHTML("beforeend", `<footer class="site"><div class="wrap"><span>© 2026 Vantage Software, Inc. · 548 Market St, San Francisco</span>
    <span>Buying for a company? Northwind employees file requests in the <a href="${PROCUREMENT_PORTAL}">Northwind Procurement portal</a>.</span></div></footer>`);
}

function disclosures(root = document) {
  root.querySelectorAll(".disclosure > button").forEach((b) => b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") === "true";
    b.setAttribute("aria-expanded", String(!open));
    b.nextElementSibling.hidden = open;
  }));
}

function pricing() {
  let cycle = "monthly";
  const tiers = document.getElementById("tiers");
  const plan = document.getElementById("calc-plan");
  const seats = document.getElementById("calc-seats");
  const drawTiers = () => {
    tiers.innerHTML = PLANS.map((p) => `<div class="tier ${p.popular ? "popular" : ""}"><h3>${p.name}</h3><div class="muted">${p.blurb}</div>
      <div class="price">${p.contact ? "Custom" : `${usd(p[cycle][0])}<small> /seat/mo</small>`}</div>
      <div class="muted" style="font-size:13px">${p.contact ? "Annual contract" : cycle === "annual" ? "billed annually" : "billed monthly"}</div>
      <ul>${p.bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
      ${p.contact ? `<a class="btn" href="/security">Contact sales</a>` : `<button class="btn" type="button" data-plan="${p.id}" aria-pressed="${plan.value === p.id}">Choose ${p.name}</button>`}</div>`).join("");
    tiers.querySelectorAll("[data-plan]").forEach((b) => b.addEventListener("click", () => { plan.value = b.dataset.plan; update(); document.getElementById("calculator").scrollIntoView({ behavior: "smooth" }); }));
  };
  const update = () => {
    const n = Math.max(1, Math.min(5000, parseInt(seats.value, 10) || 1));
    const p = PLANS.find((x) => x.id === plan.value);
    const [first, rest] = p[cycle];
    const firstSeats = Math.min(n, VOLUME_FROM - 1);
    const restSeats = Math.max(0, n - VOLUME_FROM + 1);
    const perMonth = firstSeats * first + restSeats * rest;
    const lines = [`<div class="line"><span>Seats 1–${firstSeats} × ${usd(first)} /mo</span><span>${usd(firstSeats * first)} /mo</span></div>`];
    if (restSeats) lines.push(`<div class="line"><span>Seats ${VOLUME_FROM}–${n} × ${usd(rest)} /mo <em>(volume rate)</em></span><span>${usd(restSeats * rest)} /mo</span></div>`);
    document.getElementById("receipt").innerHTML = `<div class="line"><strong>${p.name}</strong><span>${n} seats · ${cycle === "annual" ? "billed annually" : "billed monthly"}</span></div>${lines.join("")}
      <div class="line total"><span>Total per year</span><span id="calc-total">${usd(perMonth * 12)}</span></div>
      <div class="note">${cycle === "annual" ? `One invoice of ${usd(perMonth * 12)} per year.` : `${usd(perMonth)} charged every month. Switch to annual billing to save.`} Prices in USD, excluding tax.</div>`;
    tiers.querySelectorAll("[data-plan]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.plan === plan.value)));
  };
  document.querySelectorAll("[data-cycle]").forEach((b) => b.addEventListener("click", () => {
    cycle = b.dataset.cycle;
    document.querySelectorAll("[data-cycle]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    drawTiers();
    update();
  }));
  document.getElementById("seats-minus").addEventListener("click", () => { seats.value = Math.max(1, (parseInt(seats.value, 10) || 1) - 1); update(); });
  document.getElementById("seats-plus").addEventListener("click", () => { seats.value = (parseInt(seats.value, 10) || 0) + 1; update(); });
  seats.addEventListener("input", update);
  plan.addEventListener("change", update);
  const body = document.getElementById("matrix-body");
  body.innerHTML = MATRIX.map((row, i) => `<tr><td><button class="row-toggle" type="button" aria-expanded="false" data-row="${i}">${row.feature}</button></td>${row.cells.map((c) => {
    if (c === "yes") return `<td><span class="yes" aria-label="Included">✓</span></td>`;
    if (c === "no") return `<td><span class="no" aria-label="Not included">—</span></td>`;
    const [kind, text] = c.split(":");
    return `<td><span class="${kind === "partial" ? "partial" : ""}">${text}</span></td>`;
  }).join("")}</tr><tr class="detail" data-detail="${i}" hidden></tr>`).join("");
  body.querySelectorAll("[data-row]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.row);
    const detail = body.querySelector(`[data-detail="${i}"]`);
    const open = b.getAttribute("aria-expanded") === "true";
    b.setAttribute("aria-expanded", String(!open));
    detail.hidden = open;
    detail.innerHTML = open ? "" : `<td></td>${MATRIX[i].detail.map((d) => `<td>${esc(d)}</td>`).join("")}`;
  }));
  drawTiers();
  update();
  disclosures();
}

function changelog() {
  const list = document.getElementById("cl-list");
  const search = document.getElementById("cl-search");
  const open = new Set();
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = CHANGELOG.filter((e) => !q || `${e.title} ${e.body} ${e.tag}`.toLowerCase().includes(q));
    document.getElementById("cl-count").textContent = `${hits.length} of ${CHANGELOG.length} updates`;
    list.innerHTML = hits.length ? hits.map((e) => `<div class="cl-entry"><button type="button" aria-expanded="${open.has(e.date)}" data-id="${e.date}"><time datetime="${e.date}">${new Date(`${e.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</time><span class="title">${esc(e.title)}</span><span class="tag">${e.tag}</span></button>${open.has(e.date) ? `<div class="panel">${esc(e.body)}</div>` : ""}</div>`).join("") : `<p class="cl-empty">No updates match “${esc(q)}”.</p>`;
    list.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => { open.has(b.dataset.id) ? open.delete(b.dataset.id) : open.add(b.dataset.id); draw(); }));
  };
  search.addEventListener("input", draw);
  draw();
}

chrome();
if (page === "pricing") pricing();
if (page === "security") disclosures();
if (page === "changelog") changelog();
