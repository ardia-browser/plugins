import { request } from "/realism.js";

const PAGE_SIZE = 25;
const state = {
  rows: [],
  total: 0,
  hasMore: false,
  nextOffset: 0,
  loading: false,
  generation: 0,
};

const scrollEl = document.getElementById("ledger-scroll");
const bodyEl = document.getElementById("ledger-body");
const scopeEl = document.getElementById("scope-text");
const loadMoreBtn = document.getElementById("load-more");
const loadMoreWrap = document.getElementById("load-more-wrap");
const sentinelEl = document.getElementById("scroll-sentinel");
const quarterEl = document.getElementById("filter-quarter");
const categoryEl = document.getElementById("filter-category");
const statusEl = document.getElementById("filter-status");
const queryEl = document.getElementById("filter-q");
const clearBtn = document.getElementById("clear-filters");
const formEl = document.getElementById("reconcile-form");
const msgEl = document.getElementById("form-msg");

function formatUsd(cents) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rowHtml(r) {
  const statusClass = r.status === "Approved" ? "approved" : r.status === "Pending" ? "pending" : "void";
  const note = r.duplicate_of
    ? `<span class="badge dup">Duplicate of ${escapeHtml(r.duplicate_of)}</span>`
    : "";
  return `
    <tr data-id="${escapeHtml(r.id)}">
      <td class="mono">${escapeHtml(r.id)}</td>
      <td class="mono">${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.quarter)}</td>
      <td>${escapeHtml(r.vendor)}</td>
      <td>${escapeHtml(r.category)}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(r.status)}</span></td>
      <td class="num mono">${formatUsd(r.amount_cents)}</td>
      <td>${note}</td>
    </tr>
  `;
}

function updateChrome() {
  if (state.total === 0) {
    scopeEl.textContent = "Showing 0 of 0 transactions";
  } else {
    scopeEl.textContent = `Showing 1–${state.rows.length} of ${state.total} transactions`;
  }
  const remaining = Math.max(0, state.total - state.rows.length);
  loadMoreWrap.hidden = !state.hasMore;
  loadMoreBtn.disabled = state.loading;
  loadMoreBtn.textContent = state.loading ? "Loading..." : `Load more (${remaining} remaining)`;
}

function queryParams(offset) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
  if (quarterEl.value) params.set("quarter", quarterEl.value);
  if (categoryEl.value) params.set("category", categoryEl.value);
  if (statusEl.value) params.set("status", statusEl.value);
  if (queryEl.value.trim()) params.set("q", queryEl.value.trim());
  return params.toString();
}

async function fetchPage(reset) {
  if (state.loading && !reset) return;
  const gen = reset ? ++state.generation : state.generation;
  if (reset) {
    state.rows = [];
    state.nextOffset = 0;
    state.hasMore = false;
    bodyEl.innerHTML = "";
    scrollEl.scrollTop = 0;
  }
  state.loading = true;
  updateChrome();
  try {
    const res = await fetch(`/api/rows?${queryParams(state.nextOffset)}`);
    const data = await res.json();
    if (gen !== state.generation) return;
    state.rows.push(...data.rows);
    state.total = data.total;
    state.hasMore = Boolean(data.has_more);
    state.nextOffset = data.next_offset ?? state.rows.length;
    bodyEl.insertAdjacentHTML("beforeend", data.rows.map(rowHtml).join(""));
  } finally {
    if (gen === state.generation) {
      state.loading = false;
      updateChrome();
    }
  }
}

function maybeLoadMore() {
  if (!state.hasMore || state.loading) return;
  if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 140) {
    fetchPage(false);
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.hasMore && !state.loading) {
      fetchPage(false);
    }
  },
  { root: scrollEl, rootMargin: "120px" }
);
observer.observe(sentinelEl);

scrollEl.addEventListener("scroll", maybeLoadMore, { passive: true });
loadMoreBtn.addEventListener("click", () => fetchPage(false));

for (const el of [quarterEl, categoryEl, statusEl]) {
  el.addEventListener("change", () => fetchPage(true));
}

let searchTimer = null;
queryEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => fetchPage(true), 150);
});

clearBtn.addEventListener("click", () => {
  quarterEl.value = "";
  categoryEl.value = "";
  statusEl.value = "";
  queryEl.value = "";
  fetchPage(true);
});

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  msgEl.textContent = "";
  msgEl.className = "form-msg";
  const payload = {
    count: document.getElementById("f-count").value.trim(),
    total_usd: document.getElementById("f-total").value.trim(),
    top_invoice: document.getElementById("f-invoice").value.trim(),
    top_vendor: document.getElementById("f-vendor").value.trim(),
  };
  const res = await request("/api/reconcile", { method: "POST", body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    msgEl.textContent = data.error || "Could not submit reconciliation.";
    msgEl.className = "form-msg err";
    return;
  }
  msgEl.textContent = "Reconciliation recorded.";
  msgEl.className = "form-msg ok";
});

fetchPage(true);
