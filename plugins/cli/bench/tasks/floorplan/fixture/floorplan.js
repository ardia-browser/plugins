import { request } from "/realism.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const SLOTS = [
  { id: "09:00-11:00", utilization: 78 },
  { id: "11:00-13:00", utilization: 92 },
  { id: "13:00-15:00", utilization: 34 },
  { id: "15:00-17:00", utilization: 65 },
];

const DESKS = [
  { id: "C1", zone: "Collaborative", window: true, power: true, x: 29, y: 80, w: 74, h: 88 },
  { id: "C2", zone: "Collaborative", window: true, power: false, x: 117, y: 80, w: 74, h: 88 },
  { id: "C3", zone: "Collaborative", window: true, power: true, x: 205, y: 80, w: 74, h: 88 },
  { id: "C4", zone: "Collaborative", window: true, power: false, x: 293, y: 80, w: 74, h: 88 },
  { id: "C5", zone: "Collaborative", window: false, power: true, x: 70, y: 244, w: 110, h: 88 },
  { id: "C6", zone: "Collaborative", window: false, power: false, x: 216, y: 244, w: 110, h: 88 },
  { id: "Q1", zone: "Quiet", window: true, power: true, x: 393, y: 80, w: 74, h: 88 },
  { id: "Q2", zone: "Quiet", window: true, power: false, x: 481, y: 80, w: 74, h: 88 },
  { id: "Q3", zone: "Quiet", window: true, power: true, x: 569, y: 80, w: 74, h: 88 },
  { id: "Q4", zone: "Quiet", window: true, power: true, x: 657, y: 80, w: 74, h: 88 },
  { id: "Q5", zone: "Quiet", window: false, power: true, x: 434, y: 244, w: 110, h: 88 },
  { id: "Q6", zone: "Quiet", window: false, power: false, x: 580, y: 244, w: 110, h: 88 },
];

const OCCUPIED = {
  "09:00-11:00": new Set(["C2", "C3", "C4", "C6", "Q1", "Q3", "Q4", "Q5", "Q6"]),
  "11:00-13:00": new Set(["C1", "C2", "C3", "C5", "C6", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]),
  "13:00-15:00": new Set(["C3", "C6", "Q1", "Q3"]),
  "15:00-17:00": new Set(["C1", "C3", "C4", "C6", "Q1", "Q3", "Q4", "Q5"]),
};

const state = {
  slot: "09:00-11:00",
  selectedDesk: null,
  canvasHit: null,
  hoverDesk: null,
  hoverPos: null,
  reserved: new Map(),
};

const svg = document.getElementById("utilization-chart");
const canvas = document.getElementById("floorplan");
const ctx = canvas.getContext("2d");
const slotPill = document.getElementById("active-slot-pill");
const selectionDisplay = document.getElementById("selection-display");
const mapMsg = document.getElementById("map-msg");
const reserveForm = document.getElementById("reserve-form");
const reserveBtn = document.getElementById("reserve-btn");
const guestName = document.getElementById("guest-name");
const guestNotes = document.getElementById("guest-notes");
const formErr = document.getElementById("form-err");
const doneBox = document.getElementById("done-box");

function deskStatus(deskId, slot = state.slot) {
  const reservedInSlot = state.reserved.get(slot);
  if (reservedInSlot && reservedInSlot.has(deskId)) return "reserved";
  if (OCCUPIED[slot] && OCCUPIED[slot].has(deskId)) return "occupied";
  return "available";
}

function setMapMessage(msg) {
  mapMsg.textContent = msg || "";
  mapMsg.hidden = !msg;
}

function updateSidebar() {
  slotPill.textContent = `Active slot: ${state.slot}`;
  if (state.selectedDesk) {
    selectionDisplay.textContent = `Selected: ${state.selectedDesk} (${state.slot})`;
    selectionDisplay.classList.add("picked");
    reserveBtn.disabled = false;
  } else {
    selectionDisplay.textContent = "No desk selected";
    selectionDisplay.classList.remove("picked");
    reserveBtn.disabled = true;
  }
}

function selectSlot(slotId) {
  if (state.slot === slotId) return;
  state.slot = slotId;
  state.selectedDesk = null;
  state.canvasHit = null;
  setMapMessage("");
  formErr.hidden = true;
  renderChart();
  renderCanvas();
  updateSidebar();
}

function svgEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  if (text !== null) el.textContent = text;
  return el;
}

function renderChart() {
  svg.innerHTML = "";
  const baselineY = 132;
  const maxBarH = 92;
  const barW = 104;
  const gap = 46;
  const startX = 62;

  svg.appendChild(
    svgEl("line", { x1: 36, y1: baselineY, x2: 644, y2: baselineY, stroke: "#cbd5e1", "stroke-width": 1.5 }),
  );

  for (const pct of [0, 50, 100]) {
    const y = baselineY - Math.round((pct / 100) * maxBarH);
    if (pct > 0) {
      svg.appendChild(
        svgEl("line", {
          x1: 36,
          y1: y,
          x2: 644,
          y2: y,
          stroke: "#e2e8f0",
          "stroke-dasharray": "4 4",
          "stroke-width": 1,
        }),
      );
    }
    svg.appendChild(
      svgEl(
        "text",
        {
          x: 28,
          y: y + 4,
          "text-anchor": "end",
          "font-size": 11,
          fill: "#64748b",
          "pointer-events": "none",
        },
        `${pct}%`,
      ),
    );
  }

  SLOTS.forEach((slot, idx) => {
    const x = startX + idx * (barW + gap);
    const h = Math.round((slot.utilization / 100) * maxBarH);
    const y = baselineY - h;
    const isActive = slot.id === state.slot;

    const bar = svgEl("rect", {
      class: "slot-bar",
      x,
      y,
      width: barW,
      height: h,
      rx: 6,
      fill: isActive ? "#2563eb" : "#94a3b8",
      stroke: isActive ? "#1e3a8a" : "#64748b",
      "stroke-width": isActive ? 2.5 : 1,
    });
    bar.addEventListener("click", () => selectSlot(slot.id));
    svg.appendChild(bar);

    svg.appendChild(
      svgEl(
        "text",
        {
          x: x + barW / 2,
          y: y - 8,
          "text-anchor": "middle",
          "font-size": 13,
          "font-weight": 700,
          fill: isActive ? "#1d4ed8" : "#334155",
          "pointer-events": "none",
        },
        `${slot.utilization}%`,
      ),
    );

    svg.appendChild(
      svgEl(
        "text",
        {
          x: x + barW / 2,
          y: baselineY + 20,
          "text-anchor": "middle",
          "font-size": 12,
          "font-weight": isActive ? 700 : 500,
          fill: isActive ? "#0f172a" : "#475569",
          "pointer-events": "none",
        },
        slot.id,
      ),
    );

    if (isActive) {
      svg.appendChild(
        svgEl("rect", {
          x: x + 12,
          y: baselineY + 27,
          width: barW - 24,
          height: 3,
          rx: 2,
          fill: "#2563eb",
          "pointer-events": "none",
        }),
      );
    }
  });
}

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDesk(desk) {
  const status = deskStatus(desk.id);
  const isSelected = state.selectedDesk === desk.id;
  const isHovered = state.hoverDesk && state.hoverDesk.id === desk.id;

  const palette = {
    available: { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d", sub: "Available" },
    occupied: { fill: "#fee2e2", stroke: "#dc2626", text: "#7f1d1d", sub: "Occupied" },
    reserved: { fill: "#fef3c7", stroke: "#d97706", text: "#78350f", sub: "Reserved" },
  }[status];

  roundRectPath(desk.x, desk.y, desk.w, desk.h, 8);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.lineWidth = isSelected ? 3.5 : isHovered ? 2.5 : 1.75;
  ctx.strokeStyle = isSelected ? "#2563eb" : palette.stroke;
  ctx.stroke();

  if (isSelected) {
    roundRectPath(desk.x - 3, desk.y - 3, desk.w + 6, desk.h + 6, 10);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(37, 99, 235, 0.45)";
    ctx.stroke();
  }

  ctx.fillStyle = palette.text;
  ctx.font = "700 17px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(desk.id, desk.x + desk.w / 2, desk.y + 32);

  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(palette.sub, desk.x + desk.w / 2, desk.y + 54);

  if (desk.power) {
    ctx.save();
    ctx.fillStyle = "#f59e0b";
    ctx.font = "700 15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("⚡", desk.x + desk.w - 6, desk.y + 6);
    ctx.restore();
  }
}

function drawTooltip() {
  if (!state.hoverDesk || !state.hoverPos) return;
  const d = state.hoverDesk;
  const status = deskStatus(d.id);
  const label = `${d.id} · ${d.zone} Zone · ${d.window ? "Window" : "Interior"} · ${d.power ? "⚡ Power" : "No power"} · ${status[0].toUpperCase()}${status.slice(1)}`;
  ctx.save();
  ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
  const textW = ctx.measureText(label).width;
  const boxW = textW + 20;
  const boxH = 28;
  let tx = state.hoverPos.x + 12;
  let ty = state.hoverPos.y - 36;
  if (tx + boxW > 748) tx = 748 - boxW;
  if (tx < 12) tx = 12;
  if (ty < 12) ty = state.hoverPos.y + 16;
  roundRectPath(tx, ty, boxW, boxH, 6);
  ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, tx + 10, ty + boxH / 2);
  ctx.restore();
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(16, 38, 364, 332);

  ctx.fillStyle = "#eff6ff";
  ctx.fillRect(380, 38, 364, 332);

  ctx.fillStyle = "#e0f2fe";
  ctx.fillRect(16, 12, 728, 26);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(16, 12, 728, 26);

  for (let mx = 88; mx < 740; mx += 74) {
    ctx.beginPath();
    ctx.moveTo(mx, 12);
    ctx.lineTo(mx, 38);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.fillStyle = "#0369a1";
  ctx.font = "700 12px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("WINDOW WALL (NORTH)", 380, 25);

  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 38, 728, 332);

  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(380, 38);
  ctx.lineTo(380, 370);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#334155";
  ctx.font = "700 13px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("COLLABORATIVE ZONE", 198, 58);

  ctx.fillStyle = "#1e40af";
  ctx.fillText("QUIET ZONE", 562, 58);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("WALKWAY", 198, 206);
  ctx.fillText("WALKWAY", 562, 206);

  ctx.fillStyle = "#64748b";
  ctx.font = "600 10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("INTERIOR ROW", 198, 352);
  ctx.fillText("INTERIOR ROW", 562, 352);

  for (const desk of DESKS) {
    drawDesk(desk);
  }

  const legendY = 406;
  const legendItems = [
    { x: 24, fill: "#dcfce7", stroke: "#16a34a", label: "Available" },
    { x: 140, fill: "#fee2e2", stroke: "#dc2626", label: "Occupied" },
    { x: 256, fill: "#fef3c7", stroke: "#d97706", label: "Reserved" },
    { x: 372, fill: "#eff6ff", stroke: "#2563eb", label: "Selected" },
  ];
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
  for (const item of legendItems) {
    roundRectPath(item.x, legendY - 8, 16, 16, 4);
    ctx.fillStyle = item.fill;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = item.stroke;
    ctx.stroke();
    ctx.fillStyle = "#334155";
    ctx.fillText(item.label, item.x + 24, legendY);
  }

  ctx.fillStyle = "#f59e0b";
  ctx.font = "700 15px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("⚡", 488, legendY);
  ctx.fillStyle = "#334155";
  ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("Power outlet", 508, legendY);

  drawTooltip();
}

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * canvas.width) / rect.width,
    y: ((e.clientY - rect.top) * canvas.height) / rect.height,
  };
}

function hitTest(x, y) {
  return DESKS.find((d) => x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h) || null;
}

canvas.addEventListener("mousemove", (e) => {
  const pt = canvasPoint(e);
  const desk = hitTest(pt.x, pt.y);
  state.hoverDesk = desk;
  state.hoverPos = desk ? pt : null;
  canvas.style.cursor = desk && deskStatus(desk.id) === "available" ? "pointer" : "default";
  renderCanvas();
});

canvas.addEventListener("mouseleave", () => {
  state.hoverDesk = null;
  state.hoverPos = null;
  canvas.style.cursor = "default";
  renderCanvas();
});

canvas.addEventListener("click", (e) => {
  const pt = canvasPoint(e);
  const desk = hitTest(pt.x, pt.y);
  if (!desk) {
    state.selectedDesk = null;
    state.canvasHit = null;
    setMapMessage("");
    renderCanvas();
    updateSidebar();
    return;
  }
  const status = deskStatus(desk.id);
  if (status !== "available") {
    setMapMessage(`Desk ${desk.id} is ${status} during ${state.slot}. Choose a green available desk.`);
    return;
  }
  state.selectedDesk = desk.id;
  state.canvasHit = {
    x: Math.round(pt.x * 10) / 10,
    y: Math.round(pt.y * 10) / 10,
    trusted: Boolean(e.isTrusted),
  };
  setMapMessage("");
  formErr.hidden = true;
  renderCanvas();
  updateSidebar();
});

reserveForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  reserveForm.querySelectorAll(".err").forEach((el) => { el.textContent = ""; });
  guestName.classList.remove("invalid");
  formErr.hidden = true;
  doneBox.hidden = true;

  if (!state.selectedDesk || !state.canvasHit) {
    formErr.textContent = "Click an available desk on the floorplan first.";
    formErr.hidden = false;
    return;
  }

  const body = {
    slot: state.slot,
    desk: state.selectedDesk,
    name: guestName.value,
    notes: guestNotes.value,
    click_x: state.canvasHit.x,
    click_y: state.canvasHit.y,
  };

  reserveBtn.disabled = true;
  try {
    const res = await request("/api/reserve", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      for (const [field, message] of Object.entries(data.fields || {})) {
        const slotEl = reserveForm.querySelector(`[data-err="${field}"]`);
        if (slotEl) slotEl.textContent = message;
        reserveForm.querySelector(`[name="${field}"]`)?.classList.add("invalid");
      }
      const firstErr = data.fields ? Object.values(data.fields)[0] : "";
      formErr.textContent = firstErr || data.error || "Could not reserve desk";
      formErr.hidden = false;
      return;
    }

    const r = data.reservation;
    if (!state.reserved.has(r.slot)) state.reserved.set(r.slot, new Set());
    state.reserved.get(r.slot).add(r.desk);
    state.selectedDesk = null;
    state.canvasHit = null;
    doneBox.textContent = `Confirmed ${r.id}: Desk ${r.desk} reserved for ${r.name} (${r.slot}).`;
    doneBox.hidden = false;
    renderCanvas();
    updateSidebar();
  } finally {
    reserveBtn.disabled = !state.selectedDesk;
  }
});

async function loadExisting() {
  const res = await fetch("/api/reservations", { credentials: "same-origin" });
  if (res.ok) {
    const rows = await res.json().catch(() => []);
    for (const r of rows) {
      if (!state.reserved.has(r.slot)) state.reserved.set(r.slot, new Set());
      state.reserved.get(r.slot).add(r.desk);
    }
  }
  renderChart();
  renderCanvas();
  updateSidebar();
}

loadExisting();
