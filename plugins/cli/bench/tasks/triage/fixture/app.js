import { request } from "/realism.js";

const view = document.getElementById("view");
const modalRoot = document.getElementById("modal-root");
let meta = null;
let closeActivePopover = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const getJSON = async (path) => (await fetch(path, { credentials: "same-origin" })).json();
const person = (login) => meta.people.find((p) => p.login === login) || { login, name: login };
const initials = (login) => person(login).name.split(/[\s-]+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const avatar = (login, sm = false) => `<span class="avatar${sm ? " sm" : ""}" title="${esc(login)}" style="background:hsl(${[...login].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 45%)">${esc(initials(login))}</span>`;
const labelInfo = (name) => meta.labels.find((l) => l.name === name) || { name, color: "ededed" };
const textOn = (hex) => { const n = parseInt(hex, 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150 ? "#1f2328" : "#fff"; };
const labelChip = (name) => { const l = labelInfo(name); return `<span class="label" style="background:#${l.color};color:${textOn(l.color)}">${esc(name)}</span>`; };
const when = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const ISSUE_OPEN = `<svg class="issue-icon open" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`;
const ISSUE_CLOSED = `<svg class="issue-icon closed" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path fill="currentColor" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>`;

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
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2400);
}

function navigate(url) {
  history.pushState({}, "", url);
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && a.origin === location.origin && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(a.pathname + a.search);
  }
});
window.addEventListener("popstate", route);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && closeActivePopover) closeActivePopover(); });

function popover(anchor, { title, items, multi = false, filterable = true, onPick, onClose }) {
  if (closeActivePopover) closeActivePopover();
  const wrap = anchor.closest(".drop");
  const el = document.createElement("div");
  el.className = "popover";
  el.setAttribute("role", "dialog");
  const selected = new Set(items.filter((i) => i.checked).map((i) => i.value));
  const draw = (q = "") => {
    const shown = items.filter((i) => !q || `${i.label} ${i.desc || ""}`.toLowerCase().includes(q.toLowerCase()));
    el.querySelector("ul").innerHTML = shown.map((i) => `<li><button type="button" role="menuitem${multi ? "checkbox" : "radio"}" aria-checked="${selected.has(i.value)}" data-value="${esc(i.value)}">
      <span class="check">${selected.has(i.value) ? "✓" : ""}</span>${i.color ? `<span class="dot" style="background:#${i.color}"></span>` : ""}${i.avatar ? avatar(i.avatar, true) : ""}
      <span>${esc(i.label)}${i.desc ? `<small>${esc(i.desc)}</small>` : ""}</span></button></li>`).join("") || `<li class="empty">No matches</li>`;
  };
  el.innerHTML = `<header><span>${esc(title)}</span><button type="button" aria-label="Close">✕</button></header>${filterable ? `<div class="filter"><input placeholder="Filter" aria-label="Filter ${esc(title)}"></div>` : ""}<ul></ul>`;
  wrap.appendChild(el);
  draw();
  const input = el.querySelector(".filter input");
  if (input) { input.addEventListener("input", () => draw(input.value)); input.focus(); }
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    const b = e.target.closest("li button");
    if (!b) return;
    const v = b.dataset.value;
    if (multi) { selected.has(v) ? selected.delete(v) : selected.add(v); draw(input ? input.value : ""); onPick?.(v, [...selected]); }
    else { selected.clear(); selected.add(v); close(); onPick?.(v); }
  });
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener("click", outside), 0);
  el.querySelector("header button").addEventListener("click", () => close());
  function close() {
    if (!el.isConnected) return;
    document.removeEventListener("click", outside);
    el.remove();
    closeActivePopover = null;
    onClose?.([...selected]);
  }
  closeActivePopover = close;
}

const LIST_KEYS = ["state", "milestone", "label", "assignee", "sort", "q"];

function listParams() {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(LIST_KEYS.map((k) => [k, p.get(k) || (k === "state" ? "open" : k === "sort" ? "newest" : "")]));
}

function setListParams(next) {
  const merged = { ...listParams(), ...next };
  const qs = new URLSearchParams();
  for (const k of LIST_KEYS) if (merged[k] && !(k === "state" && merged[k] === "open") && !(k === "sort" && merged[k] === "newest")) qs.set(k, merged[k]);
  navigate(`/issues${qs.toString() ? `?${qs}` : ""}`);
}

function issueRow(i) {
  return `<div class="issue-row">${i.state === "open" ? ISSUE_OPEN : ISSUE_CLOSED}<div class="issue-main">
    <a class="issue-title" href="/issues/${i.number}" data-link>${esc(i.title)}</a>${i.labels.map(labelChip).join("")}
    <div class="issue-meta">#${i.number} ${i.state === "open" ? `opened ${when(i.created)} by ${esc(i.author)}` : `by ${esc(i.author)} was closed`}${i.milestone ? ` · <span title="Milestone">⚑ ${esc(i.milestone)}</span>` : ""}</div></div>
    <div class="issue-side">${i.linked_prs.length ? `<span title="Linked pull request">⇄ ${i.linked_prs.length}</span>` : ""}<span>${i.assignees.map((a) => avatar(a, true)).join("")}</span>${i.comments ? `<span title="Comments">💬 ${i.comments}</span>` : ""}</div></div>`;
}

async function renderList() {
  document.title = "Issues · northwind/ledger · Forge";
  const p = listParams();
  let page = 1;
  view.innerHTML = `<div class="toolbar"><input type="search" id="q" placeholder="Search all issues" value="${esc(p.q)}" aria-label="Search issues">
    <a class="btn" href="/milestones" data-link>⚑ Milestones</a><button class="btn primary" type="button" disabled title="You don't have permission to open issues here">New issue</button></div>
    <div class="box"><div class="box-head"><div class="state-toggle"><button data-state="open" class="${p.state === "open" ? "on" : ""}">◯ <span id="open-count">–</span> Open</button><button data-state="closed" class="${p.state === "closed" ? "on" : ""}">✓ <span id="closed-count">–</span> Closed</button></div>
    <div class="filters">${["label", "milestone", "assignee", "sort"].map((k) => `<div class="drop"><button type="button" data-filter="${k}" class="${p[k] && !(k === "sort" && p[k] === "newest") ? "set" : ""}">${filterLabel(k, p)}</button></div>`).join("")}</div></div>
    <div id="rows"><p class="empty">Loading issues…</p></div><div class="load-more" id="more" hidden><button class="btn" type="button">Load more issues</button></div></div>`;
  const rows = document.getElementById("rows");
  const more = document.getElementById("more");
  const load = async (append) => {
    const qs = new URLSearchParams({ ...p, page: String(page) });
    const data = await getJSON(`/api/issues?${qs}`);
    document.getElementById("open-count").textContent = data.counts.open;
    document.getElementById("closed-count").textContent = data.counts.closed;
    const html = data.issues.map(issueRow).join("");
    if (append) rows.insertAdjacentHTML("beforeend", html); else rows.innerHTML = html || `<p class="empty">No results matched your search.</p>`;
    more.hidden = page * data.per_page >= data.total;
    more.querySelector("button").textContent = `Load more issues (${data.total - Math.min(page * data.per_page, data.total)} more)`;
  };
  more.querySelector("button").addEventListener("click", async () => { page += 1; await load(true); });
  view.querySelectorAll("[data-state]").forEach((b) => b.addEventListener("click", () => setListParams({ state: b.dataset.state })));
  let timer;
  document.getElementById("q").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => setListParams({ q: e.target.value.trim() }), 350); });
  view.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => openFilter(b, b.dataset.filter, p)));
  await load(false);
}

function filterLabel(kind, p) {
  if (kind === "label") return p.label ? `Label: ${p.label}` : "Label";
  if (kind === "milestone") return p.milestone ? `Milestone: ${p.milestone}` : "Milestones";
  if (kind === "assignee") return p.assignee ? `Assignee: ${p.assignee === "none" ? "nobody" : p.assignee}` : "Assignee";
  return `Sort: ${({ newest: "Newest", oldest: "Oldest", comments: "Most commented" })[p.sort]}`;
}

function openFilter(anchor, kind, p) {
  if (kind === "label") {
    popover(anchor, { title: "Filter by label", items: [{ value: "", label: "All labels", checked: !p.label }, ...meta.labels.map((l) => ({ value: l.name, label: l.name, desc: l.description, color: l.color, checked: p.label === l.name }))], onPick: (v) => setListParams({ label: v }) });
  } else if (kind === "milestone") {
    popover(anchor, { title: "Filter by milestone", items: [{ value: "", label: "All milestones", checked: !p.milestone }, ...meta.milestones.map((m) => ({ value: m.title, label: m.title, desc: `${m.state === "open" ? "Due" : "Closed, was due"} ${m.due}`, checked: p.milestone === m.title }))], onPick: (v) => setListParams({ milestone: v }) });
  } else if (kind === "assignee") {
    popover(anchor, { title: "Filter by assignee", items: [{ value: "", label: "Anyone", checked: !p.assignee }, { value: "none", label: "Assigned to nobody", checked: p.assignee === "none" }, ...meta.people.map((u) => ({ value: u.login, label: u.login, desc: u.name, avatar: u.login, checked: p.assignee === u.login }))], onPick: (v) => setListParams({ assignee: v }) });
  } else {
    popover(anchor, { title: "Sort by", filterable: false, items: [["newest", "Newest"], ["oldest", "Oldest"], ["comments", "Most commented"]].map(([v, l]) => ({ value: v, label: l, checked: p.sort === v })), onPick: (v) => setListParams({ sort: v }) });
  }
}

function timelineHTML(issue) {
  const first = `<div class="comment">${avatar(issue.author)}<div class="box"><div class="box-head"><strong>${esc(issue.author)}</strong> opened this issue on ${when(issue.created)}</div><div class="comment-body">${esc(issue.body)}</div></div></div>`;
  return first + issue.timeline.map((e) => {
    if (e.kind === "comment") return `<div class="comment">${avatar(e.author)}<div class="box"><div class="box-head"><strong>${esc(e.author)}</strong> commented on ${when(e.at)}</div><div class="comment-body">${esc(e.body)}</div></div></div>`;
    if (e.kind === "labeled") return `<div class="event">🏷 <strong>${esc(e.author)}</strong> ${e.added.length ? `added ${e.added.map(labelChip).join("")}` : ""} ${e.removed.length ? `removed ${e.removed.map(labelChip).join("")}` : ""}</div>`;
    if (e.kind === "assigned") return `<div class="event">👤 <strong>${esc(e.author)}</strong> ${e.added.length ? `assigned ${e.added.map(esc).join(", ")}` : ""} ${e.removed.length ? `unassigned ${e.removed.map(esc).join(", ")}` : ""}</div>`;
    if (e.kind === "closed") return `<div class="event">✓ <strong>${esc(e.author)}</strong> closed this as ${e.reason === "duplicate" ? `a duplicate of <a href="/issues/${e.duplicate_of}" data-link>#${e.duplicate_of}</a>` : e.reason === "not_planned" ? "not planned" : "completed"}</div>`;
    if (e.kind === "reopened") return `<div class="event">↺ <strong>${esc(e.author)}</strong> reopened this</div>`;
    return "";
  }).join("");
}

async function renderIssue(n) {
  const res = await fetch(`/api/issues/${n}`);
  if (!res.ok) { view.innerHTML = `<p class="empty">Issue #${n} not found.</p>`; return; }
  drawIssue(await res.json());
}

function drawIssue(issue) {
  document.title = `${issue.title} · Issue #${issue.number} · northwind/ledger`;
  const closedText = issue.state === "closed" ? (issue.close_reason === "duplicate" ? `Closed as duplicate of #${issue.duplicate_of}` : issue.close_reason === "not_planned" ? "Closed as not planned" : "Closed") : "Open";
  view.innerHTML = `<div class="detail-head"><h1>${esc(issue.title)} <span>#${issue.number}</span></h1>
    <div class="detail-sub"><span class="state ${issue.state}">${issue.state === "open" ? "◯ Open" : "✓ Closed"}</span><span><strong>${esc(issue.author)}</strong> opened this issue on ${when(issue.created)} · ${issue.timeline.filter((e) => e.kind === "comment").length} comments</span></div></div>
  <div class="layout"><div><div class="timeline">${timelineHTML(issue)}</div>
    <div class="composer">${avatar(meta.viewer)}<div class="box"><div class="composer-tabs"><span>Write</span></div><textarea id="comment-body" placeholder="Leave a comment" aria-label="Comment body"></textarea>
      <div class="composer-actions"><p class="error" id="comment-error" hidden></p>
        ${issue.state === "open" ? `<div class="drop btn-group"><button class="btn" type="button" id="close-main">✓ Close issue</button><button class="btn" type="button" id="close-menu" aria-label="More close options">▾</button></div>` : `<button class="btn" type="button" id="reopen">Reopen issue</button>`}
        <button class="btn primary" type="button" id="comment-submit">Comment</button></div></div></div></div>
  <aside class="sidebar">
    <section><h3>Assignees <span class="drop"><button type="button" id="edit-assignees" aria-label="Edit assignees">⚙</button></span></h3>${issue.assignees.length ? issue.assignees.map((a) => `<div class="person">${avatar(a, true)}${esc(a)}</div>`).join("") : `<div class="none">No one assigned</div>`}</section>
    <section><h3>Labels <span class="drop"><button type="button" id="edit-labels" aria-label="Edit labels">⚙</button></span></h3>${issue.labels.length ? issue.labels.map(labelChip).join(" ") : `<div class="none">None yet</div>`}</section>
    <section><h3>Milestone</h3>${issue.milestone ? `<a href="/issues?milestone=${encodeURIComponent(issue.milestone)}" data-link>⚑ ${esc(issue.milestone)}</a>` : `<div class="none">No milestone</div>`}</section>
    <section><h3>Development</h3>${issue.linked_prs.length ? issue.linked_prs.map((pr) => `<div class="dev-link">⇄ <a href="/pulls/${pr.number}" data-link>${esc(pr.title)} #${pr.number}</a></div>`).join("") : `<div class="none">No branches or pull requests</div>`}</section>
    <section><h3>Status</h3><div class="none">${esc(closedText)}</div></section>
  </aside></div>`;
  const textarea = document.getElementById("comment-body");
  const errorEl = document.getElementById("comment-error");
  const act = async (path, body, message) => {
    errorEl.hidden = true;
    try { const out = await post(`/api/issues/${issue.number}/${path}`, body); drawIssue(out.issue); if (message) toast(message); return true; }
    catch (ex) { errorEl.textContent = ex.message; errorEl.hidden = false; return false; }
  };
  document.getElementById("comment-submit").addEventListener("click", () => act("comments", { body: textarea.value }, "Comment posted"));
  document.getElementById("reopen")?.addEventListener("click", () => act("reopen", {}, "Issue reopened"));
  document.getElementById("close-main")?.addEventListener("click", async () => {
    if (textarea.value.trim() && !(await act("comments", { body: textarea.value }))) return;
    act("close", { reason: "completed" }, "Issue closed");
  });
  document.getElementById("close-menu")?.addEventListener("click", (e) => popover(e.currentTarget, {
    title: "Close as", filterable: false,
    items: [{ value: "completed", label: "Close as completed", desc: "Done, closed, fixed, resolved" }, { value: "not_planned", label: "Close as not planned", desc: "Won't fix, can't repro, stale" }, { value: "duplicate", label: "Close as duplicate", desc: "Duplicate of another issue" }],
    onPick: (v) => (v === "duplicate" ? duplicateDialog(issue, act) : act("close", { reason: v }, "Issue closed")),
  }));
  document.getElementById("edit-labels").addEventListener("click", (e) => popover(e.currentTarget, {
    title: "Apply labels to this issue", multi: true,
    items: meta.labels.map((l) => ({ value: l.name, label: l.name, desc: l.description, color: l.color, checked: issue.labels.includes(l.name) })),
    onClose: (labels) => { if ([...labels].sort().join() !== [...issue.labels].sort().join()) act("labels", { labels }, "Labels updated"); },
  }));
  document.getElementById("edit-assignees").addEventListener("click", (e) => popover(e.currentTarget, {
    title: "Assign up to 3 people", multi: true,
    items: meta.people.map((u) => ({ value: u.login, label: u.login, desc: u.name, avatar: u.login, checked: issue.assignees.includes(u.login) })),
    onClose: (people) => { if ([...people].sort().join() !== [...issue.assignees].sort().join()) act("assignees", { assignees: people }, "Assignees updated"); },
  }));
}

function duplicateDialog(issue, act) {
  modalRoot.innerHTML = `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dup-title">
    <header><span id="dup-title">Close #${issue.number} as a duplicate</span><button type="button" aria-label="Close dialog" id="dup-x">×</button></header>
    <div class="body"><label for="dup-q">Duplicate of</label><input id="dup-q" placeholder="Search by issue number or title" autocomplete="off">
      <div class="pick-list" id="dup-list"><p class="empty">Type to search issues</p></div><p class="hint">The original issue stays open. This issue will be closed and linked to it.</p><p class="error" id="dup-error" hidden></p></div>
    <footer><button class="btn" type="button" id="dup-cancel">Cancel</button><button class="btn primary" type="button" id="dup-ok" disabled>Close as duplicate</button></footer></div></div>`;
  let picked = null;
  const list = document.getElementById("dup-list");
  const ok = document.getElementById("dup-ok");
  const close = () => { modalRoot.innerHTML = ""; };
  const search = async (q) => {
    const data = await getJSON(`/api/issues?${new URLSearchParams({ state: "all", q: q.replace(/^#/, "") })}`);
    const hits = data.issues.filter((i) => i.number !== issue.number);
    list.innerHTML = hits.length ? hits.map((i) => `<button type="button" role="option" aria-selected="${picked === i.number}" data-n="${i.number}"><span class="num">#${i.number}</span><span>${esc(i.title)}</span></button>`).join("") : `<p class="empty">No matching issues</p>`;
  };
  let timer;
  document.getElementById("dup-q").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => search(e.target.value.trim()), 250); });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-n]");
    if (!b) return;
    picked = Number(b.dataset.n);
    list.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    ok.disabled = false;
  });
  document.getElementById("dup-x").addEventListener("click", close);
  document.getElementById("dup-cancel").addEventListener("click", close);
  ok.addEventListener("click", async () => {
    const textarea = document.getElementById("comment-body");
    if (textarea?.value.trim() && !(await act("comments", { body: textarea.value }))) return;
    if (await act("close", { reason: "duplicate", duplicate_of: picked }, `Closed as a duplicate of #${picked}`)) close();
    else { document.getElementById("dup-error").textContent = document.getElementById("comment-error")?.textContent || "Couldn't close"; document.getElementById("dup-error").hidden = false; }
  });
  document.getElementById("dup-q").focus();
}

async function renderPull(n) {
  const res = await fetch(`/api/pulls/${n}`);
  if (!res.ok) { view.innerHTML = `<p class="empty">Pull request #${n} not found.</p>`; return; }
  const pr = await res.json();
  document.title = `${pr.title} · Pull Request #${pr.number} · northwind/ledger`;
  const badge = pr.state === "merged" ? "merged" : pr.draft ? "draft" : "open";
  view.innerHTML = `<div class="detail-head"><h1>${esc(pr.title)} <span>#${pr.number}</span></h1>
    <div class="detail-sub"><span class="state ${badge}">${badge === "merged" ? "Merged" : badge === "draft" ? "Draft" : "Open"}</span><span><strong>${esc(pr.author)}</strong> wants to merge into <span class="branch">${esc(pr.base)}</span> from <span class="branch">${esc(pr.head)}</span></span></div></div>
    <div class="pr-tabs" role="tablist"><button role="tab" aria-selected="true" data-tab="conversation">Conversation <span class="count">${pr.discussion.length}</span></button><button role="tab" aria-selected="false" data-tab="files">Files changed <span class="count">${pr.files.length}</span></button></div>
    <div class="layout"><div id="pr-panel"></div><aside class="sidebar"><section><h3>Reviewers</h3><div class="none">No reviews</div></section>
      <section><h3>Development</h3>${pr.linked_issues.map((i) => `<div class="dev-link">◯ Successfully merging this pull request may close <a href="/issues/${i}" data-link>#${i}</a></div>`).join("")}</section></aside></div>`;
  const panel = document.getElementById("pr-panel");
  const show = (tab) => {
    view.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    panel.innerHTML = tab === "files"
      ? `<div class="box"><div class="box-head">${pr.files.length} files changed · <span style="color:var(--green)">+${pr.additions}</span> <span style="color:var(--red)">−${pr.deletions}</span></div><ul class="files" style="margin:0;padding:8px 32px">${pr.files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`
      : `<div class="timeline"><div class="comment">${avatar(pr.author)}<div class="box"><div class="box-head"><strong>${esc(pr.author)}</strong> commented on ${when(pr.created)}</div><div class="comment-body">${esc(pr.body)}</div></div></div>${pr.discussion.map((c) => `<div class="comment">${avatar(c.author)}<div class="box"><div class="box-head"><strong>${esc(c.author)}</strong> commented on ${when(c.at)}</div><div class="comment-body">${esc(c.body)}</div></div></div>`).join("")}</div>`;
  };
  view.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  show("conversation");
}

async function renderMilestones() {
  document.title = "Milestones · northwind/ledger";
  const list = await getJSON("/api/milestones");
  view.innerHTML = `<div class="box">${list.map((m) => { const pct = m.open + m.closed ? Math.round((m.closed / (m.open + m.closed)) * 100) : 0; return `<div class="milestone"><h2><a href="/issues?milestone=${encodeURIComponent(m.title)}" data-link>${esc(m.title)}</a></h2><div class="hint">${m.state === "open" ? `Due by ${m.due}` : `Closed · was due ${m.due}`} · ${esc(m.description)}</div><div class="progress"><span style="width:${pct}%"></span></div><div class="hint">${pct}% complete · <a href="/issues?milestone=${encodeURIComponent(m.title)}" data-link>${m.open} open</a> · <a href="/issues?milestone=${encodeURIComponent(m.title)}&state=closed" data-link>${m.closed} closed</a></div></div>`; }).join("")}</div>`;
}

async function route() {
  if (closeActivePopover) closeActivePopover();
  modalRoot.innerHTML = "";
  const path = location.pathname.replace(/\/$/, "");
  const section = path.startsWith("/pulls") ? "pulls" : path.startsWith("/milestones") ? "milestones" : "issues";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === section));
  let m;
  if ((m = path.match(/^\/issues\/(\d+)$/))) await renderIssue(Number(m[1]));
  else if ((m = path.match(/^\/pulls\/(\d+)$/))) await renderPull(Number(m[1]));
  else if (path === "/milestones") await renderMilestones();
  else await renderList();
  const counts = await getJSON("/api/issues?state=open");
  document.getElementById("nav-open").textContent = counts.counts.open;
}

async function boot() {
  meta = await getJSON("/api/meta");
  await route();
}

boot();
