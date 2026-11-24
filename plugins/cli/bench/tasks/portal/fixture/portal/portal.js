import { request } from "/realism.js";

const PLANS = [
  { id: "starter", name: "Starter", annual: 19, monthly: 24, desc: "Core workspaces and standard support" },
  { id: "growth", name: "Growth", annual: 35, monthly: 42, desc: "Role permissions, analytics, and webhooks" },
  { id: "scale", name: "Scale", annual: 48, monthly: 58, desc: "Dedicated SSO, audit logs, and priority SLA" },
];

const state = {
  plan: "starter",
  cycle: "monthly",
  seats: 5,
  po: "",
  auth: null,
  upgrade: null,
  error: "",
};

const planSpec = (id) => PLANS.find((p) => p.id === id) || PLANS[0];

function computeAmount() {
  const spec = planSpec(state.plan);
  const seats = Number.isInteger(state.seats) && state.seats >= 1 ? state.seats : 0;
  const unit = state.cycle === "annual" ? spec.annual : spec.monthly;
  return unit * seats * (state.cycle === "annual" ? 12 : 1);
}

function formatMoney(n) {
  return `$${Number(n).toLocaleString("en-US")}`;
}

const PAY_ORIGIN = "http://127.0.0.1:8922";

function payOrigin() {
  return new URL(PAY_ORIGIN).origin;
}

function buildIframeUrl() {
  const amount = computeAmount();
  const params = new URLSearchParams({
    amount: String(amount),
    plan: state.plan,
    seats: String(state.seats),
    cycle: state.cycle,
  });
  return `${payOrigin()}/embed/pay?${params.toString()}`;
}

class SeatConfig extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; margin-top: 18px; padding-top: 18px; border-top: 1px solid #e2e8f0; }
        .grid { display: grid; grid-template-columns: 160px 1fr; gap: 16px; }
        label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: #1e293b; }
        .hint { font-weight: 400; font-size: 12px; color: #64748b; }
        input {
          width: 100%;
          padding: 9px 11px;
          font-size: 14px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          color: #0f172a;
          background: #ffffff;
          font-family: inherit;
        }
        input:focus { outline: 2px solid #2563eb; outline-offset: 1px; border-color: #2563eb; }
      </style>
      <div class="grid">
        <label>
          <span>Seats</span>
          <input id="seats-input" type="number" min="1" max="500" value="5" aria-label="Seats">
          <span class="hint">1 to 500 licensed users</span>
        </label>
        <label>
          <span>Purchase Order (PO)</span>
          <input id="po-input" type="text" placeholder="PO-..." autocomplete="off" aria-label="Purchase Order">
          <span class="hint">Printed on your enterprise invoice</span>
        </label>
      </div>
    `;
    const seatsEl = this.shadowRoot.getElementById("seats-input");
    const poEl = this.shadowRoot.getElementById("po-input");
    seatsEl.addEventListener("input", () => {
      const parsed = Number.parseInt(seatsEl.value, 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 500) {
        this.dispatchEvent(new CustomEvent("seats-change", { detail: { seats: parsed }, bubbles: true, composed: true }));
      }
    });
    poEl.addEventListener("input", () => {
      this.dispatchEvent(new CustomEvent("po-change", { detail: { po: poEl.value }, bubbles: true, composed: true }));
    });
  }
}

class PlanSelector extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: #ffffff;
          border: 1px solid #dbe2ee;
          border-radius: 14px;
          padding: 20px 22px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
        h2 { margin: 0; font-size: 17px; color: #0f172a; }
        .cycle {
          display: inline-flex;
          background: #f1f5f9;
          padding: 3px;
          border-radius: 10px;
          border: 1px solid #dbe2ee;
        }
        .cycle label { cursor: pointer; }
        .cycle input { position: absolute; opacity: 0; pointer-events: none; }
        .cycle span {
          display: inline-block;
          padding: 6px 12px;
          border-radius: 7px;
          font-size: 13px;
          font-weight: 600;
          color: #475569;
        }
        .cycle input:checked + span {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1);
        }
        .plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .plan {
          display: flex;
          flex-direction: column;
          gap: 6px;
          border: 1.5px solid #dbe2ee;
          border-radius: 11px;
          padding: 14px;
          cursor: pointer;
          background: #ffffff;
          transition: border-color 0.12s ease, background 0.12s ease;
        }
        .plan:hover { border-color: #93c5fd; }
        .plan.selected { border-color: #2563eb; background: #eff6ff; }
        .plan-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .plan-name { font-size: 15px; font-weight: 700; color: #0f172a; }
        .plan-price { font-size: 20px; font-weight: 700; color: #0f172a; }
        .plan-price small { font-size: 12px; font-weight: 500; color: #64748b; }
        .plan-desc { font-size: 12px; color: #475569; }
        .live-bar {
          margin-top: 16px;
          padding: 12px 14px;
          border-radius: 10px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 14px;
        }
        .live-bar strong { font-size: 16px; color: #0f172a; }
      </style>
      <section class="card">
        <div class="head">
          <h2>Select plan &amp; billing cycle</h2>
          <div class="cycle" role="radiogroup" aria-label="Billing cycle">
            <label><input type="radio" name="cycle" value="monthly" checked><span>Monthly</span></label>
            <label><input type="radio" name="cycle" value="annual"><span>Annual</span></label>
          </div>
        </div>
        <div class="plans" id="plans" role="radiogroup" aria-label="Subscription plan"></div>
        <seat-config id="seat-config"></seat-config>
        <div class="live-bar">
          <span id="formula"></span>
          <strong id="live-total"></strong>
        </div>
      </section>
    `;

    this.shadowRoot.querySelectorAll('input[name="cycle"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.dispatchEvent(new CustomEvent("cycle-change", { detail: { cycle: input.value }, bubbles: true, composed: true }));
        }
      });
    });

    this.render();
  }

  render() {
    const container = this.shadowRoot.getElementById("plans");
    container.innerHTML = "";
    for (const plan of PLANS) {
      const unit = state.cycle === "annual" ? plan.annual : plan.monthly;
      const label = document.createElement("label");
      label.className = `plan${state.plan === plan.id ? " selected" : ""}`;
      label.innerHTML = `
        <div class="plan-top">
          <span class="plan-name">${plan.name}</span>
          <input type="radio" name="plan" value="${plan.id}" ${state.plan === plan.id ? "checked" : ""}>
        </div>
        <div class="plan-price">$${unit}<small>/seat/mo</small></div>
        <div class="plan-desc">${plan.desc}</div>
      `;
      label.querySelector("input").addEventListener("change", () => {
        this.dispatchEvent(new CustomEvent("plan-change", { detail: { plan: plan.id }, bubbles: true, composed: true }));
      });
      container.appendChild(label);
    }

    const spec = planSpec(state.plan);
    const unit = state.cycle === "annual" ? spec.annual : spec.monthly;
    const total = computeAmount();
    const formulaEl = this.shadowRoot.getElementById("formula");
    const totalEl = this.shadowRoot.getElementById("live-total");
    if (state.cycle === "annual") {
      formulaEl.textContent = `${spec.name} · $${unit} × ${state.seats} seats × 12 mo`;
      totalEl.textContent = `${formatMoney(total)}/yr`;
    } else {
      formulaEl.textContent = `${spec.name} · $${unit} × ${state.seats} seats`;
      totalEl.textContent = `${formatMoney(total)}/mo`;
    }
  }
}

class ConfirmUpgrade extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: #ffffff;
          border: 1px solid #dbe2ee;
          border-radius: 14px;
          padding: 20px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        h2 { margin: 0 0 14px; font-size: 17px; color: #0f172a; }
        dl { margin: 0 0 16px; display: grid; grid-template-columns: 1fr auto; row-gap: 10px; column-gap: 12px; font-size: 13px; }
        dt { color: #64748b; }
        dd { margin: 0; font-weight: 600; color: #0f172a; text-align: right; }
        .divider { border-top: 1px solid #e2e8f0; margin: 14px 0; }
        .total-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
        .total-row span { font-size: 14px; color: #475569; font-weight: 600; }
        .total-row strong { font-size: 22px; color: #0f172a; }
        .status {
          font-size: 12px;
          padding: 9px 11px;
          border-radius: 8px;
          margin-bottom: 14px;
          background: #fef3c7;
          color: #92400e;
        }
        .status.ready { background: #dcfce7; color: #166534; }
        .error {
          font-size: 12px;
          color: #b91c1c;
          background: #fee2e2;
          padding: 8px 10px;
          border-radius: 8px;
          margin-bottom: 12px;
        }
        .done {
          font-size: 13px;
          color: #166534;
          background: #dcfce7;
          border: 1px solid #86efac;
          padding: 12px;
          border-radius: 10px;
          margin-bottom: 14px;
        }
        button {
          width: 100%;
          padding: 11px 16px;
          font-size: 14px;
          font-weight: 600;
          border: none;
          border-radius: 9px;
          background: #2563eb;
          color: #ffffff;
          cursor: pointer;
          font-family: inherit;
        }
        button:hover:not(:disabled) { background: #1d4ed8; }
        button:disabled { background: #94a3b8; cursor: not-allowed; }
      </style>
      <section class="card">
        <h2>Order summary</h2>
        <dl>
          <dt>Plan</dt><dd id="s-plan"></dd>
          <dt>Billing cycle</dt><dd id="s-cycle"></dd>
          <dt>Seats</dt><dd id="s-seats"></dd>
          <dt>Purchase Order</dt><dd id="s-po"></dd>
        </dl>
        <div class="divider"></div>
        <div class="total-row">
          <span>Total due</span>
          <strong id="s-total"></strong>
        </div>
        <div class="status" id="s-auth"></div>
        <div class="error" id="s-err" hidden></div>
        <div class="done" id="s-done" hidden></div>
        <button id="finalize-btn" type="button" disabled>Finalize upgrade</button>
      </section>
    `;
    this.shadowRoot.getElementById("finalize-btn").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("finalize-upgrade", { bubbles: true, composed: true }));
    });
    this.render();
  }

  render() {
    const spec = planSpec(state.plan);
    const total = computeAmount();
    this.shadowRoot.getElementById("s-plan").textContent = spec.name;
    this.shadowRoot.getElementById("s-cycle").textContent = state.cycle === "annual" ? "Annual" : "Monthly";
    this.shadowRoot.getElementById("s-seats").textContent = String(state.seats);
    this.shadowRoot.getElementById("s-po").textContent = state.po.trim() || "—";
    this.shadowRoot.getElementById("s-total").textContent =
      state.cycle === "annual" ? `${formatMoney(total)}/yr` : `${formatMoney(total)}/mo`;

    const authEl = this.shadowRoot.getElementById("s-auth");
    const btn = this.shadowRoot.getElementById("finalize-btn");
    const authValid =
      state.auth &&
      state.auth.amount === total &&
      state.auth.plan === state.plan &&
      state.auth.seats === state.seats &&
      state.auth.cycle === state.cycle;

    if (authValid) {
      authEl.className = "status ready";
      authEl.textContent = `ClearPay authorized (${formatMoney(state.auth.amount)} · card •••• ${state.auth.card_last4 || "••••"})`;
      btn.disabled = false;
    } else {
      authEl.className = "status";
      authEl.textContent = "Complete ClearPay payment authorization to enable upgrade.";
      btn.disabled = true;
    }

    const errEl = this.shadowRoot.getElementById("s-err");
    errEl.hidden = !state.error;
    errEl.textContent = state.error;

    const doneEl = this.shadowRoot.getElementById("s-done");
    if (state.upgrade) {
      doneEl.hidden = false;
      doneEl.textContent = `Upgrade ${state.upgrade.id} confirmed: ${spec.name} (${state.upgrade.seats} seats, ${state.upgrade.cycle}, ${formatMoney(state.upgrade.amount)}, PO ${state.upgrade.po}).`;
    } else {
      doneEl.hidden = true;
    }
  }
}

customElements.define("seat-config", SeatConfig);
customElements.define("plan-selector", PlanSelector);
customElements.define("confirm-upgrade", ConfirmUpgrade);

const planEl = document.getElementById("plan-selector");
const confirmEl = document.getElementById("confirm-upgrade");
const payFrame = document.getElementById("pay-frame");
const payBadge = document.getElementById("pay-badge");

let lastFrameUrl = payFrame.getAttribute("src") || "";

function syncUI(reloadFrame = false) {
  planEl.render();
  confirmEl.render();
  const nextUrl = buildIframeUrl();
  if (reloadFrame && nextUrl !== lastFrameUrl) {
    state.auth = null;
    state.upgrade = null;
    state.error = "";
    lastFrameUrl = nextUrl;
    payFrame.src = nextUrl;
    confirmEl.render();
  }
  if (state.auth) {
    payBadge.textContent = `Authorized · ${formatMoney(state.auth.amount)}`;
    payBadge.classList.add("authorized");
  } else {
    payBadge.textContent = "Awaiting authorization";
    payBadge.classList.remove("authorized");
  }
}

planEl.addEventListener("plan-change", (e) => {
  state.plan = e.detail.plan;
  state.error = "";
  syncUI(true);
});

planEl.addEventListener("cycle-change", (e) => {
  state.cycle = e.detail.cycle;
  state.error = "";
  syncUI(true);
});

planEl.addEventListener("seats-change", (e) => {
  state.seats = e.detail.seats;
  state.error = "";
  syncUI(true);
});

planEl.addEventListener("po-change", (e) => {
  state.po = e.detail.po;
  state.error = "";
  syncUI(false);
});

window.addEventListener("message", (event) => {
  if (event.origin !== payOrigin() || event.source !== payFrame.contentWindow) return;
  const data = event.data;
  if (!data || data.type !== "clearpay:authorized" || !data.token) return;
  state.auth = {
    token: String(data.token),
    amount: Number(data.amount),
    plan: String(data.plan || state.plan),
    seats: Number(data.seats || state.seats),
    cycle: String(data.cycle || state.cycle),
    card_last4: String(data.card_last4 || ""),
  };
  state.error = "";
  syncUI(false);
});

confirmEl.addEventListener("finalize-upgrade", async () => {
  if (!state.auth) return;
  state.error = "";
  state.upgrade = null;
  const btn = confirmEl.shadowRoot.getElementById("finalize-btn");
  btn.disabled = true;
  try {
    const res = await request("/api/upgrade", {
      method: "POST",
      body: {
        plan: state.plan,
        cycle: state.cycle,
        seats: state.seats,
        po: state.po.trim(),
        amount: computeAmount(),
        payment_token: state.auth.token,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const firstFieldErr = data.fields ? Object.values(data.fields)[0] : "";
      state.error = firstFieldErr || data.error || "Could not finalize upgrade";
      syncUI(false);
      return;
    }
    state.upgrade = data.upgrade;
    syncUI(false);
  } finally {
    confirmEl.render();
  }
});

syncUI(false);
