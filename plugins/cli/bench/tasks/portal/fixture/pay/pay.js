import { request } from "/realism.js";

const params = new URLSearchParams(location.search);
const order = {
  amount: Number.parseInt(params.get("amount") || "120", 10),
  plan: (params.get("plan") || "starter").toLowerCase(),
  seats: Number.parseInt(params.get("seats") || "5", 10),
  cycle: (params.get("cycle") || "monthly").toLowerCase(),
};

const summaryEl = document.getElementById("charge-summary");
const planTitle = order.plan.charAt(0).toUpperCase() + order.plan.slice(1);
summaryEl.textContent = `$${order.amount.toLocaleString("en-US")} · ${planTitle} (${order.seats} seats, ${order.cycle})`;

const form = document.getElementById("pay-form");
const errBanner = document.getElementById("form-err");
const okBanner = document.getElementById("auth-ok");
const submitBtn = document.getElementById("authorize-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  form.querySelectorAll(".err").forEach((el) => { el.textContent = ""; });
  form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
  errBanner.hidden = true;
  okBanner.hidden = true;

  const body = {
    cardholder: document.getElementById("cardholder").value,
    card_number: document.getElementById("card-number").value,
    expiry: document.getElementById("expiry").value,
    cvc: document.getElementById("cvc").value,
    zip: document.getElementById("zip").value,
    amount: order.amount,
    plan: order.plan,
    seats: order.seats,
    cycle: order.cycle,
  };

  submitBtn.disabled = true;
  try {
    const res = await request("/api/authorize", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      for (const [field, message] of Object.entries(data.fields || {})) {
        const slot = form.querySelector(`[data-err="${field}"]`);
        if (slot) slot.textContent = message;
        form.querySelector(`[name="${field}"]`)?.classList.add("invalid");
      }
      errBanner.textContent = data.error || "Payment authorization failed";
      errBanner.hidden = false;
      return;
    }

    okBanner.textContent = `Authorized $${data.amount.toLocaleString("en-US")} on card ending ${data.card_last4}. You may now finalize your upgrade.`;
    okBanner.hidden = false;
    const parentOrigin = new URL("http://127.0.0.1:8921").origin;
    window.parent.postMessage(
      {
        type: "clearpay:authorized",
        token: data.token,
        amount: data.amount,
        plan: data.plan,
        seats: data.seats,
        cycle: data.cycle,
        card_last4: data.card_last4,
      },
      parentOrigin,
    );
  } finally {
    submitBtn.disabled = false;
  }
});
