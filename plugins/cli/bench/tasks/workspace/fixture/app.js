import { request } from "/realism.js";

let workspace = null;
let draggedCardId = null;
let activeEditKey = null;

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const boardEl = document.getElementById("kanban-board");
const kanbanStatusEl = document.getElementById("kanban-status");
const budgetGridEl = document.getElementById("budget-grid");
const budgetStatusEl = document.getElementById("budget-status");
const briefEditorEl = document.getElementById("brief-editor");
const briefStatusEl = document.getElementById("brief-status");
const briefMsgEl = document.getElementById("brief-msg");
const saveBriefBtn = document.getElementById("save-brief");
const filesStatusEl = document.getElementById("files-status");
const currentFilenameEl = document.getElementById("current-filename");
const fileMetaEl = document.getElementById("file-meta");
const csvHeadEl = document.getElementById("csv-head");
const csvBodyEl = document.getElementById("csv-body");
const uploadFormEl = document.getElementById("upload-form");
const csvInputEl = document.getElementById("csv-upload");
const selectedFileLabelEl = document.getElementById("selected-file-label");

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatCurrency(val) {
  return `$${Number(val).toLocaleString("en-US")}`;
}

function setStatus(el, text, ok = true) {
  el.textContent = text;
  el.className = `status-pill ${ok ? "ok" : "err"}`;
}

function selectTab(name) {
  for (const t of tabs) {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const p of panels) {
    p.hidden = p.id !== `panel-${name}`;
  }
}

for (const t of tabs) {
  t.addEventListener("click", () => selectTab(t.dataset.tab));
}

function renderKanban() {
  boardEl.innerHTML = "";
  for (const col of workspace.columns) {
    const cards = workspace.cards.filter((c) => c.column === col.id);
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.column = col.id;
    colEl.setAttribute("aria-label", `${col.label} column`);
    colEl.innerHTML = `
      <div class="col-head">
        <h3>${escapeHtml(col.label)}</h3>
        <span class="col-count">${cards.length}</span>
      </div>
      <div class="card-list" role="list"></div>
    `;
    const listEl = colEl.querySelector(".card-list");
    for (const card of cards) {
      const cardEl = document.createElement("article");
      cardEl.className = "kanban-card";
      cardEl.draggable = true;
      cardEl.dataset.cardId = card.id;
      cardEl.setAttribute("role", "listitem");
      cardEl.innerHTML = `
        <div class="card-title">${escapeHtml(card.title)}</div>
        <div class="card-meta">
          <span>${escapeHtml(card.owner)}</span>
          <span class="tag">${escapeHtml(card.tag)}</span>
        </div>
      `;
      cardEl.addEventListener("dragstart", (e) => {
        draggedCardId = card.id;
        cardEl.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
      });
      cardEl.addEventListener("dragend", () => {
        cardEl.classList.remove("dragging");
        draggedCardId = null;
      });
      listEl.appendChild(cardEl);
    }

    colEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      colEl.classList.add("drag-over");
    });
    colEl.addEventListener("dragleave", (e) => {
      if (!colEl.contains(e.relatedTarget)) {
        colEl.classList.remove("drag-over");
      }
    });
    colEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      colEl.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain") || draggedCardId;
      draggedCardId = null;
      if (!id) return;
      const existing = workspace.cards.find((c) => c.id === id);
      if (!existing || existing.column === col.id) return;
      const res = await request("/api/cards/move", {
        method: "POST",
        body: { card_id: id, column: col.id },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(kanbanStatusEl, data.error || "Could not move card.", false);
        return;
      }
      workspace = data.state;
      setStatus(kanbanStatusEl, `Moved "${existing.title}" to ${col.label}.`, true);
      renderKanban();
    });
    boardEl.appendChild(colEl);
  }
}

function renderBudget() {
  budgetGridEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "sheet-row header";
  header.setAttribute("role", "row");
  header.innerHTML = `
    <div class="sheet-cell" role="columnheader">Line Item</div>
    <div class="sheet-cell" role="columnheader">Category</div>
    <div class="sheet-cell" role="columnheader">Formula / Type</div>
    <div class="sheet-cell num" role="columnheader">Amount</div>
  `;
  budgetGridEl.appendChild(header);

  for (const item of workspace.grid_items) {
    const row = document.createElement("div");
    row.className = "sheet-row";
    row.setAttribute("role", "row");
    row.innerHTML = `
      <div class="sheet-cell" role="rowheader">${escapeHtml(item.label)}</div>
      <div class="sheet-cell" role="gridcell">${escapeHtml(item.category)}</div>
      <div class="sheet-cell" role="gridcell">Input (USD)</div>
    `;
    row.appendChild(makeEditableCell(item.key, item.label, item.value, formatCurrency(item.value)));
    budgetGridEl.appendChild(row);
  }

  const subRow = document.createElement("div");
  subRow.className = "sheet-row summary";
  subRow.setAttribute("role", "row");
  subRow.innerHTML = `
    <div class="sheet-cell" role="rowheader">Subtotal</div>
    <div class="sheet-cell" role="gridcell">Computed</div>
    <div class="sheet-cell" role="gridcell">=SUM(Line Items)</div>
    <div class="sheet-cell num" role="gridcell" aria-readonly="true" data-formula="subtotal">${formatCurrency(workspace.subtotal)}</div>
  `;
  budgetGridEl.appendChild(subRow);

  const pctRow = document.createElement("div");
  pctRow.className = "sheet-row";
  pctRow.setAttribute("role", "row");
  pctRow.innerHTML = `
    <div class="sheet-cell" role="rowheader">Contingency %</div>
    <div class="sheet-cell" role="gridcell">Reserve</div>
    <div class="sheet-cell" role="gridcell">Input (%)</div>
  `;
  pctRow.appendChild(
    makeEditableCell("contingency_pct", "Contingency %", workspace.contingency_pct, `${workspace.contingency_pct}%`)
  );
  budgetGridEl.appendChild(pctRow);

  const totalRow = document.createElement("div");
  totalRow.className = "sheet-row total";
  totalRow.setAttribute("role", "row");
  totalRow.innerHTML = `
    <div class="sheet-cell" role="rowheader">Total Budget</div>
    <div class="sheet-cell" role="gridcell">Computed</div>
    <div class="sheet-cell" role="gridcell">=ROUND(Subtotal*(1+Contingency%/100))</div>
    <div class="sheet-cell num" role="gridcell" aria-readonly="true" data-formula="total_budget">${formatCurrency(workspace.total_budget)}</div>
  `;
  budgetGridEl.appendChild(totalRow);
}

function makeEditableCell(key, label, rawValue, displayText) {
  const cell = document.createElement("div");
  cell.className = "sheet-cell num editable";
  cell.setAttribute("role", "gridcell");
  cell.setAttribute("tabindex", "0");
  cell.setAttribute("aria-label", label);
  cell.dataset.cellKey = key;
  cell.textContent = displayText;

  const startEdit = () => {
    if (activeEditKey === key) return;
    activeEditKey = key;
    cell.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-input";
    input.value = String(rawValue);
    input.setAttribute("aria-label", `Edit ${label}`);
    cell.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const commit = async () => {
      if (finished) return;
      finished = true;
      activeEditKey = null;
      const val = input.value.trim();
      const res = await request("/api/grid/cell", {
        method: "POST",
        body: { cell: key, value: val },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(budgetStatusEl, data.error || "Invalid cell value.", false);
        renderBudget();
        return;
      }
      workspace = data.state;
      setStatus(budgetStatusEl, `Updated ${label}. Total Budget: ${formatCurrency(workspace.total_budget)}.`, true);
      renderBudget();
    };

    const cancel = () => {
      if (finished) return;
      finished = true;
      activeEditKey = null;
      renderBudget();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", () => {
      commit();
    });
  };

  cell.addEventListener("dblclick", startEdit);
  cell.addEventListener("keydown", (e) => {
    if (activeEditKey === key) return;
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const editableCells = [...budgetGridEl.querySelectorAll(".sheet-cell.editable")];
      const idx = editableCells.indexOf(cell);
      const next = editableCells[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) next.focus();
    }
  });
  return cell;
}

function renderBrief() {
  briefEditorEl.innerHTML = workspace.brief.content_html;
  briefStatusEl.value = workspace.brief.status;
}

for (const btn of document.querySelectorAll(".tool-btn")) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    briefEditorEl.focus();
    const cmd = btn.dataset.cmd;
    if (cmd === "bold") {
      document.execCommand("bold");
    } else if (cmd === "heading") {
      document.execCommand("formatBlock", false, "h3");
    } else if (cmd === "bullet") {
      document.execCommand("insertUnorderedList");
    }
  });
}

saveBriefBtn.addEventListener("click", async () => {
  const res = await request("/api/brief", {
    method: "POST",
    body: {
      content_html: briefEditorEl.innerHTML,
      content_text: briefEditorEl.innerText.trim(),
      status: briefStatusEl.value,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(briefMsgEl, data.error || "Could not save brief.", false);
    return;
  }
  workspace = data.state;
  setStatus(briefMsgEl, `Brief saved (${workspace.brief.status}).`, true);
});

function renderFiles() {
  const f = workspace.file;
  currentFilenameEl.textContent = f.filename;
  fileMetaEl.textContent = `${f.rows.length} compliance items${f.uploaded ? " · updated upload" : ""}`;
  csvHeadEl.innerHTML = `<tr>${f.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  csvBodyEl.innerHTML = f.rows
    .map((row) => {
      const cells = row.map((cell, idx) => {
        if (idx === 2) {
          const cls = cell.toLowerCase() === "complete" ? "pill-complete" : "pill-pending";
          return `<td class="${cls}">${escapeHtml(cell)}</td>`;
        }
        return `<td>${escapeHtml(cell)}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
}

function readFileText(file) {
  if (typeof file.text === "function") {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsText(file);
  });
}

csvInputEl.addEventListener("change", () => {
  const file = csvInputEl.files && csvInputEl.files[0];
  selectedFileLabelEl.textContent = file ? `Selected: ${file.name}` : "No file selected";
});

uploadFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = csvInputEl.files && csvInputEl.files[0];
  if (!file) {
    setStatus(filesStatusEl, "Select a CSV file before uploading.", false);
    return;
  }
  const content = await readFileText(file);
  const res = await request("/api/files/upload", {
    method: "POST",
    body: { filename: file.name, content },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(filesStatusEl, data.error || "Upload failed.", false);
    return;
  }
  workspace = data.state;
  setStatus(filesStatusEl, `Uploaded ${file.name}.`, true);
  renderFiles();
});

async function init() {
  const res = await fetch("/api/state");
  workspace = await res.json();
  renderKanban();
  renderBudget();
  renderBrief();
  renderFiles();
}

init();
