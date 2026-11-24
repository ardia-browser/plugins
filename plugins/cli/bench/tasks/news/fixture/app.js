import { request } from "/realism.js";

const view = document.getElementById("view");
const state = { session: null, articles: [], newsletterArmed: false, clicks: 0 };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const getJSON = async (path) => (await fetch(path, { credentials: "same-origin" })).json();

async function post(path, body) {
  const res = await request(path, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function navigate(path) {
  history.pushState({}, "", path);
  route();
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-link]");
  if (link && link.origin === location.origin && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    document.getElementById("account-menu").hidden = true;
    document.getElementById("search-results").hidden = true;
    navigate(link.pathname);
  }
});
window.addEventListener("popstate", route);

function card(a, size = "small") {
  return `<a class="card" href="/articles/${a.slug}" data-link>
    <div class="hero ${a.hero}" data-label="${esc(a.section)}"></div>
    <div class="card-body"><div class="kicker">${esc(a.section)}</div>
      ${size === "lead" ? `<h2>${esc(a.title)}</h2>` : `<h3>${esc(a.title)}</h3>`}
      <p>${esc(a.dek)}</p><div class="byline">${esc(a.author)} · ${fmtDate(a.date)} · ${a.read_min} min read</div></div></a>`;
}

function renderHome(section) {
  const list = state.articles.filter((a) => !section || a.section.toLowerCase() === section);
  document.querySelectorAll(".sections a").forEach((a) => a.classList.toggle("active", section && a.pathname.endsWith(section)));
  if (section) {
    view.innerHTML = `<div class="section-title">${esc(section)}</div><div class="river">${list.map((a) => card(a)).join("")}</div>`;
    return;
  }
  const [lead, ...rest] = [...list].sort((a, b) => b.date.localeCompare(a.date));
  view.innerHTML = `<div class="lead-grid">${card(lead, "lead")}<div class="stack">${rest.slice(0, 2).map((a) => card(a)).join("")}</div></div>
    <div class="section-title">Latest</div><div class="river">${rest.slice(2).map((a) => card(a)).join("")}</div>`;
}

function blocksHTML(blocks) {
  return blocks.map((b) => {
    if (b.kind === "p") return `<p>${esc(b.text)}</p>`;
    if (b.kind === "verdict") return `<div class="verdict">${esc(b.text)}</div>`;
    if (b.kind === "table") {
      return `<table class="data"><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join("")}</tr>`).join("")}</tbody></table>`;
    }
    return "";
  }).join("");
}

async function renderArticle(slug) {
  view.innerHTML = `<p class="loading">Loading article…</p>`;
  const res = await fetch(`/api/articles/${slug}`);
  if (!res.ok) { view.innerHTML = `<div class="empty">That article doesn't exist.</div>`; return; }
  const a = await res.json();
  document.title = `${a.title} | Signal Daily`;
  const saved = state.session.bookmarks.includes(slug);
  const groups = [...new Set(a.accordion.map((q) => q.group))];
  view.innerHTML = `<article class="story">
    <div class="kicker">${esc(a.section)}</div><h1>${esc(a.title)}</h1><p class="dek">${esc(a.dek)}</p>
    <div class="story-meta"><span>By <strong>${esc(a.author)}</strong> · ${fmtDate(a.date)} · ${a.read_min} min read</span>
      <button class="btn ${saved ? "saved" : ""}" id="save" aria-pressed="${saved}">${saved ? "✓ Saved to Reading List" : "＋ Save to Reading List"}</button></div>
    <div class="hero ${a.hero}" data-label="${esc(a.section)}"></div>
    ${a.body.map((p) => `<p>${esc(p)}</p>`).join("")}
    ${a.tabs.length ? `<div class="tabs" role="tablist">${a.tabs.map((t, i) => `<button role="tab" data-tab="${t.id}" aria-selected="${i === 0}">${esc(t.label)}</button>`).join("")}</div><div class="tab-panel" role="tabpanel" id="tab-panel"></div>` : ""}
    ${groups.length ? `<section class="accordion">${groups.map((g) => `<h3>${esc(g)}</h3>${a.accordion.filter((q) => q.group === g).map((q) => `<div class="acc-item"><button aria-expanded="false" data-acc="${q.id}">${esc(q.question)}</button><div class="acc-body" hidden></div></div>`).join("")}`).join("")}</section>` : ""}
    ${a.related.length ? `<aside class="related"><div class="kicker">Read next</div>${a.related.map((r) => `<p><a href="/articles/${r.slug}" data-link>${esc(r.title)}</a></p>`).join("")}</aside>` : ""}
  </article>`;
  document.getElementById("save").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const next = btn.getAttribute("aria-pressed") !== "true";
    btn.disabled = true;
    try {
      const out = await post("/api/bookmarks", { slug, saved: next });
      state.session.bookmarks = out.bookmarks;
      updateCount();
      btn.classList.toggle("saved", next);
      btn.setAttribute("aria-pressed", String(next));
      btn.textContent = next ? "✓ Saved to Reading List" : "＋ Save to Reading List";
      toast(next ? "Saved to your Reading List" : "Removed from your Reading List");
    } catch (err) { toast(err.message); } finally { btn.disabled = false; }
  });
  const tabs = view.querySelectorAll("[data-tab]");
  const showTab = async (id) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === id)));
    const panel = document.getElementById("tab-panel");
    panel.innerHTML = `<p class="loading">Loading…</p>`;
    const part = await getJSON(`/api/articles/${slug}/tabs/${id}`);
    if ([...tabs].find((t) => t.getAttribute("aria-selected") === "true")?.dataset.tab === id) panel.innerHTML = blocksHTML(part.blocks);
  };
  tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  if (tabs.length) showTab(tabs[0].dataset.tab);
  view.querySelectorAll("[data-acc]").forEach((btn) => btn.addEventListener("click", async () => {
    const body = btn.nextElementSibling;
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    if (open) { body.hidden = true; body.innerHTML = ""; return; }
    body.hidden = false;
    body.innerHTML = `<span class="loading">Loading…</span>`;
    const part = await getJSON(`/api/articles/${slug}/accordion/${btn.dataset.acc}`);
    if (btn.getAttribute("aria-expanded") === "true") body.textContent = part.answer;
  }));
  armNewsletter(1500);
}

function renderReadingList() {
  document.title = "Reading list | Signal Daily";
  const saved = state.session.bookmarks.map((s) => state.articles.find((a) => a.slug === s)).filter(Boolean);
  view.innerHTML = `<div class="page-head"><h1>Reading list</h1></div>
    ${saved.length ? saved.map((a) => `<div class="list-row"><div><a href="/articles/${a.slug}" data-link>${esc(a.title)}</a><div class="byline">${esc(a.section)} · ${fmtDate(a.date)}</div></div><button class="btn" data-remove="${a.slug}">Remove</button></div>`).join("") : `<div class="empty">Nothing saved yet. Use “Save to Reading List” on any article.</div>`}`;
  view.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    const out = await post("/api/bookmarks", { slug: b.dataset.remove, saved: false });
    state.session.bookmarks = out.bookmarks;
    updateCount();
    renderReadingList();
  }));
}

async function renderNotes() {
  document.title = "Research notes | Signal Daily";
  const notes = await getJSON("/api/notes");
  const options = state.articles.map((a) => `<option value="${a.slug}">${esc(a.title)}</option>`).join("");
  view.innerHTML = `<div class="page-head"><h1>Research notes</h1></div>
  <div class="notes-grid"><form class="note" id="note-form" novalidate>
    <label>Note title<input name="title" placeholder="e.g. Laptop shortlist: battery and price"></label>
    <label>Source article<select name="source"><option value="">Choose an article…</option>${options}</select></label>
    <fieldset><legend>Facts from the source</legend>
      <div class="split">
        <label>Battery life measured<span class="hint">Signal's own test, as published</span>
          <div class="with-unit"><input name="battery_hours" inputmode="numeric" placeholder="0"><span>h</span><input name="battery_minutes" inputmode="numeric" placeholder="0"><span>min</span></div></label>
        <label>Price as reviewed<span class="hint">US list price of the tested configuration</span>
          <div class="with-unit"><span>$</span><input name="price" inputmode="decimal" placeholder="0"></div></label>
      </div>
      <label style="margin-top:12px">Firmware version in the retest<span class="hint">Exactly as Signal lists it</span><input name="firmware" placeholder="e.g. 2.0.1"></label>
    </fieldset>
    <label>Summary<textarea name="summary" placeholder="Anything else worth remembering"></textarea></label>
    <p class="form-error" id="note-error" hidden></p>
    <div><button class="btn primary" type="submit">Submit note</button></div>
  </form>
  <div><h3 style="margin-top:0">Submitted</h3>${notes.length ? notes.map((n) => `<div class="note-card"><strong>${esc(n.title)}</strong> <span class="byline">${esc(n.id)}</span>
    <dl><dt>Source</dt><dd>${esc(state.articles.find((a) => a.slug === n.source)?.title || n.source)}</dd><dt>Battery</dt><dd>${esc(n.battery_hours)} h ${esc(n.battery_minutes)} min</dd><dt>Price</dt><dd>$${esc(n.price)}</dd><dt>Firmware</dt><dd>${esc(n.firmware)}</dd></dl></div>`).join("") : `<div class="empty">No notes yet.</div>`}</div></div>`;
  document.getElementById("note-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    const err = document.getElementById("note-error");
    err.hidden = true;
    try {
      await post("/api/notes", body);
      toast("Note submitted");
      renderNotes();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

function updateCount() {
  document.getElementById("reading-count").textContent = state.session.bookmarks.length;
}

async function route() {
  window.scrollTo(0, 0);
  const path = location.pathname.replace(/\/$/, "") || "/";
  document.title = "Signal Daily";
  let m;
  if ((m = path.match(/^\/articles\/([a-z0-9-]+)$/))) await renderArticle(m[1]);
  else if ((m = path.match(/^\/section\/([a-z-]+)$/))) renderHome(m[1]);
  else if (path === "/reading-list") renderReadingList();
  else if (path === "/notes") await renderNotes();
  else renderHome();
}

function showNewsletter() {
  if (state.session.newsletter !== "pending") return;
  document.getElementById("newsletter").hidden = false;
}

function armNewsletter(delay) {
  if (state.session.newsletter !== "pending" || state.newsletterArmed) return;
  state.newsletterArmed = true;
  setTimeout(showNewsletter, delay);
}

async function closeNewsletter(action, email) {
  await post("/api/newsletter", action === "subscribe" ? { action, email } : { action });
  state.session.newsletter = action === "subscribe" ? "subscribed" : "dismissed";
  document.getElementById("newsletter").hidden = true;
}

function wireChrome() {
  const menu = document.getElementById("account-menu");
  document.getElementById("account-button").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".account")) menu.hidden = true; });
  const search = document.getElementById("search");
  const results = document.getElementById("search-results");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    const hits = q ? state.articles.filter((a) => `${a.title} ${a.dek}`.toLowerCase().includes(q)) : [];
    results.hidden = !q;
    results.innerHTML = hits.length ? hits.map((a) => `<a href="/articles/${a.slug}" data-link>${esc(a.title)} <small>· ${esc(a.section)} · ${fmtDate(a.date)}</small></a>`).join("") : `<a>No results for “${esc(q)}”</a>`;
  });
  document.getElementById("newsletter-close").addEventListener("click", () => closeNewsletter("dismiss"));
  document.getElementById("newsletter-dismiss").addEventListener("click", () => closeNewsletter("dismiss"));
  document.getElementById("newsletter-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("newsletter-error");
    try { await closeNewsletter("subscribe", document.getElementById("newsletter-email").value); toast("You're subscribed!"); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  const consent = document.getElementById("consent");
  const decide = async (choice) => { await post("/api/consent", { choice }); state.session.consent = choice; consent.hidden = true; };
  document.getElementById("consent-accept").addEventListener("click", () => decide("accepted"));
  document.getElementById("consent-reject").addEventListener("click", () => decide("rejected"));
  document.getElementById("consent-manage").addEventListener("click", () => { document.getElementById("consent-prefs").hidden = false; });
  document.getElementById("consent-save").addEventListener("click", () => decide("custom"));
  consent.hidden = state.session.consent !== null;
  window.addEventListener("scroll", () => { if (window.scrollY > 400) armNewsletter(0); }, { passive: true });
  document.addEventListener("click", () => { state.clicks += 1; if (state.clicks >= 4) armNewsletter(300); }, true);
}

async function boot() {
  [state.session, state.articles] = await Promise.all([getJSON("/api/session"), getJSON("/api/articles")]);
  wireChrome();
  updateCount();
  await route();
}

boot();
