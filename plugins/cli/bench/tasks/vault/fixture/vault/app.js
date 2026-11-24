import { request } from "/realism.js";

const keysBody = document.getElementById("keys-body");
const tokensBody = document.getElementById("tokens-body");
const userEmail = document.getElementById("user-email");
const sessionBanner = document.getElementById("session-banner");
const sessionBannerText = document.getElementById("session-banner-text");
const reauthLink = document.getElementById("reauth-link");
const statusBanner = document.getElementById("status-banner");

function showStatus(text, tone = "info") {
  statusBanner.textContent = text;
  statusBanner.className = `status-banner ${tone}`;
}

function showSessionExpired(reauthUrl) {
  sessionBannerText.textContent = "Your session expired. Sign in again to continue.";
  reauthLink.href = reauthUrl;
  sessionBanner.classList.remove("hidden");
  statusBanner.className = "status-banner hidden";
}

function badgeClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "active") return "badge badge-active";
  if (s === "deprecated") return "badge badge-warn";
  return "badge badge-revoked";
}

function renderKeys(keys) {
  keysBody.innerHTML = "";
  for (const k of keys) {
    const tr = document.createElement("tr");
    tr.dataset.keyId = k.id;
    tr.innerHTML = `
      <td class="mono">${k.id}</td>
      <td>v${k.version}</td>
      <td><span class="${badgeClass(k.status)}">${k.status}</span></td>
      <td>${k.scope}</td>
      <td class="muted">${k.updated}</td>
      <td><button type="button" class="btn-secondary rotate-btn">Rotate key</button></td>
    `;
    const btn = tr.querySelector(".rotate-btn");
    btn.addEventListener("click", () => handleRotate(k.id));
    keysBody.appendChild(tr);
  }
}

function renderTokens(tokens) {
  tokensBody.innerHTML = "";
  for (const t of tokens) {
    const revoked = t.status === "Revoked";
    const tr = document.createElement("tr");
    tr.dataset.tokenId = t.id;
    tr.innerHTML = `
      <td class="mono">${t.id}</td>
      <td><span class="${badgeClass(t.status)}">${t.status}</span></td>
      <td>${t.label}</td>
      <td class="muted">${t.last_used}</td>
      <td><button type="button" class="btn-danger revoke-btn"${revoked ? " disabled" : ""}>${revoked ? "Revoked" : "Revoke"}</button></td>
    `;
    const btn = tr.querySelector(".revoke-btn");
    if (!revoked) {
      btn.addEventListener("click", () => handleRevoke(t.id));
    }
    tokensBody.appendChild(tr);
  }
}

async function handleRotate(keyId) {
  const confirmed = window.confirm("Rotate " + keyId + "? Existing signatures expire in 5 minutes.");
  if (!confirmed) {
    showStatus(`Rotation cancelled for ${keyId}.`, "info");
    return;
  }
  const res = await request("/api/keys/rotate", {
    method: "POST",
    body: { key_id: keyId },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "session_expired") {
    showSessionExpired(data.reauth_url);
    return;
  }
  if (!res.ok) {
    showStatus(data.error || "Could not rotate signing key.", "error");
    return;
  }
  renderKeys(data.keys);
  renderTokens(data.tokens);
  showStatus(`Rotated ${keyId} to v${data.key.version}.`, "success");
}

async function handleRevoke(tokenId) {
  const entered = window.prompt("Type the token ID to confirm revocation:");
  if (entered === null) {
    showStatus(`Revocation cancelled for ${tokenId}.`, "info");
    return;
  }
  if (entered.trim() !== tokenId) {
    showStatus(`Confirmation did not match ${tokenId}.`, "error");
    return;
  }
  const res = await request("/api/tokens/revoke", {
    method: "POST",
    body: { token_id: tokenId },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "session_expired") {
    showSessionExpired(data.reauth_url);
    return;
  }
  if (!res.ok) {
    showStatus(data.error || "Could not revoke API token.", "error");
    return;
  }
  renderKeys(data.keys);
  renderTokens(data.tokens);
  showStatus(`Revoked token ${tokenId}.`, "success");
  window.alert("Token " + tokenId + " revoked.");
}

async function init() {
  const res = await request("/api/state");
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "session_expired") {
    showSessionExpired(data.reauth_url);
    return;
  }
  if (res.status === 401 && data.login_url) {
    location.href = data.login_url;
    return;
  }
  userEmail.textContent = data.user || "Signed in";
  renderKeys(data.keys || []);
  renderTokens(data.tokens || []);
}

init();
