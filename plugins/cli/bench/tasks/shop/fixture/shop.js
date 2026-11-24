import { signForm } from "/realism.js";

document.querySelectorAll("select[data-autosubmit]").forEach((select) => {
  const form = select.form;
  const apply = form.querySelector("button[type=submit]");
  if (apply) apply.classList.add("sr");
  select.addEventListener("change", () => form.submit());
});

document.querySelectorAll("form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    if (form.method.toLowerCase() !== "post") return;
    event.preventDefault();
    if (form.dataset.submitting) return;
    form.dataset.submitting = "1";
    const button = form.querySelector("button[type=submit]:not(.sr)");
    let snapshot;
    try {
      snapshot = await signForm(form);
    } catch (error) {
      delete form.dataset.submitting;
      throw error;
    }
    if (button) {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = "Working…";
    }
    document.body.appendChild(snapshot);
    HTMLFormElement.prototype.submit.call(snapshot);
  });
});

const orderTotal = document.getElementById("order-total");
const shipCost = document.getElementById("ship-cost");
const dollars = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
document.querySelectorAll("input[name=shipping]").forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked || !orderTotal || !shipCost) return;
    const cents = Number(radio.dataset.cost);
    shipCost.textContent = cents ? dollars(cents) : "Free";
    orderTotal.textContent = dollars(Number(orderTotal.dataset.beforeShipping) + cents);
  });
});

const summary = document.querySelector(".error-summary");
if (summary) summary.focus();
const newAddress = document.getElementById("ship-new");
if (newAddress) {
  const firstField = document.getElementById("name");
  newAddress.addEventListener("change", () => { if (newAddress.checked && firstField) firstField.focus(); });
}
