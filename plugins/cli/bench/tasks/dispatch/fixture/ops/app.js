import { request } from "/realism.js";

const form = document.getElementById("failover-form");
const serviceEl = document.getElementById("service");
const regionEl = document.getElementById("region");
const modeEl = document.getElementById("mode");
const responderInput = document.getElementById("responder-input");
const responderIdInput = document.getElementById("responder-id");
const listbox = document.getElementById("responder-listbox");
const escalationInput = document.getElementById("escalation-code");
const ownerConfirmedEl = document.getElementById("owner-confirmed");
const statusBadge = document.getElementById("status-badge");
const alertBanner = document.getElementById("alert-banner");
const receiptEl = document.getElementById("receipt");

let debounceTimer = null;
let activeController = null;
let revertTimer = null;
let optionsList = [];
let highlightedIndex = -1;

function setStatus(text, tone) {
  statusBadge.textContent = text;
  statusBadge.className = `status-badge status-${tone}`;
}

function showAlert(text, tone) {
  alertBanner.textContent = text;
  alertBanner.className = `alert-banner ${tone}`;
}

function clearAlert() {
  alertBanner.textContent = "";
  alertBanner.className = "alert-banner hidden";
}

function closeListbox() {
  listbox.classList.add("hidden");
  listbox.innerHTML = "";
  optionsList = [];
  highlightedIndex = -1;
  responderInput.setAttribute("aria-expanded", "false");
}

function selectResponder(item) {
  responderInput.value = item.name;
  responderIdInput.value = item.id;
  closeListbox();
}

function renderListbox(items) {
  optionsList = items;
  highlightedIndex = items.length ? 0 : -1;
  listbox.innerHTML = "";
  if (!items.length) {
    closeListbox();
    return;
  }
  items.forEach((item, idx) => {
    const li = document.createElement("li");
    li.role = "option";
    li.dataset.id = item.id;
    li.dataset.name = item.name;
    li.className = idx === highlightedIndex ? "option active" : "option";
    li.innerHTML = `<span class="opt-name">${item.name}</span><span class="opt-meta">${item.team} · ${item.role}</span>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectResponder(item);
    });
    li.addEventListener("click", () => selectResponder(item));
    listbox.appendChild(li);
  });
  listbox.classList.remove("hidden");
  responderInput.setAttribute("aria-expanded", "true");
}

function updateHighlight() {
  const nodes = listbox.querySelectorAll("li");
  nodes.forEach((node, idx) => {
    node.className = idx === highlightedIndex ? "option active" : "option";
  });
}

function scheduleSearch(query) {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  debounceTimer = setTimeout(async () => {
    activeController = new AbortController();
    try {
      const res = await fetch(`/api/responders?q=${encodeURIComponent(query)}`, {
        signal: activeController.signal,
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const data = await res.json();
      renderListbox(data.responders || []);
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }, 350);
}

responderInput.addEventListener("input", () => {
  responderIdInput.value = "";
  const q = responderInput.value.trim();
  if (!q) {
    closeListbox();
    return;
  }
  scheduleSearch(q);
});

responderInput.addEventListener("keydown", (e) => {
  if (listbox.classList.contains("hidden") || !optionsList.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightedIndex = (highlightedIndex + 1) % optionsList.length;
    updateHighlight();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightedIndex = (highlightedIndex - 1 + optionsList.length) % optionsList.length;
    updateHighlight();
  } else if (e.key === "Enter" && highlightedIndex >= 0) {
    e.preventDefault();
    selectResponder(optionsList[highlightedIndex]);
  } else if (e.key === "Escape") {
    closeListbox();
  }
});

responderInput.addEventListener("blur", () => {
  setTimeout(closeListbox, 150);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
  clearAlert();
  receiptEl.classList.add("hidden");

  const payload = {
    service: serviceEl.value,
    region: regionEl.value,
    mode: modeEl.value,
    responder: responderInput.value.trim(),
    responder_id: responderIdInput.value,
    escalation_code: escalationInput.value.trim(),
    owner_confirmed: ownerConfirmedEl.checked,
  };

  setStatus("Failover queued ✓", "queued");
  const res = await request("/api/failover", {
    method: "POST",
    body: payload,
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 429) {
    setStatus("Rate limited (429)", "warn");
    showAlert(data.message || "Ops API rate limited (429). Wait a moment and retry.", "warn");
    return;
  }

  if (!res.ok) {
    setStatus("Error", "error");
    showAlert(data.error || "Failover request failed.", "error");
    return;
  }

  if (data.reverted) {
    revertTimer = setTimeout(() => {
      setStatus("Draft (reverted: requires incident owner confirmation and valid escalation code)", "error");
      showAlert(data.reason || "Requires incident owner confirmation and valid escalation code", "error");
    }, 400);
    return;
  }

  setStatus(data.status || "Dispatched", "success");
  const d = data.dispatch || payload;
  receiptEl.textContent = "";
  const heading = document.createElement("h2");
  heading.textContent = "Failover Dispatched";
  const dl = document.createElement("dl");
  dl.className = "receipt-grid";
  const rows = [
    ["Service", d.service, true],
    ["Target Region", d.region, true],
    ["Failover Mode", d.mode, true],
    ["Responder", d.responder, false],
    ["Escalation Code", d.escalation_code, true],
    ["Owner Confirmed", d.owner_confirmed ? "Yes" : "No", false],
  ];
  for (const [label, value, isCode] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (isCode) {
      const code = document.createElement("code");
      code.textContent = String(value ?? "");
      dd.appendChild(code);
    } else {
      dd.textContent = String(value ?? "");
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  receiptEl.appendChild(heading);
  receiptEl.appendChild(dl);
  receiptEl.classList.remove("hidden");
});
