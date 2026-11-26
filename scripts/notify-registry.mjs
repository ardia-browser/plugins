#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";
import { isMain } from "./lib.mjs";

const HELP = `usage: node scripts/notify-registry.mjs <owner/repo> <tag>

Tells the ardia.dev registry a release is out, the way GitHub's own release webhook would: it POSTs
{ action: "published", repository: { full_name }, release: { tag_name } } to $ARDIA_REGISTRY_WEBHOOK_URL (the
platform's /api/v1/registry/webhook/github) with x-github-event: release, a fresh x-github-delivery and
x-hub-signature-256: sha256=<HMAC-SHA256 of the body with $ARDIA_REGISTRY_WEBHOOK_SECRET>. Without both variables it
says so and does nothing; the registry also reindexes on its own schedule.
`;

export function webhookRequest(repo, tag, secret, delivery = randomUUID()) {
  const body = JSON.stringify({ action: "published", repository: { full_name: repo }, release: { tag_name: tag } });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "ardia-plugins-release",
      "x-github-event": "release",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature,
    },
  };
}

export async function notify(repo, tag, env = process.env, fetchImpl = globalThis.fetch) {
  const url = env.ARDIA_REGISTRY_WEBHOOK_URL;
  const secret = env.ARDIA_REGISTRY_WEBHOOK_SECRET;
  if (!url || !secret) return { sent: false, reason: "ARDIA_REGISTRY_WEBHOOK_URL and ARDIA_REGISTRY_WEBHOOK_SECRET aren't both set" };
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error(`${url} isn't an https URL`);
  const request = webhookRequest(repo, tag, secret);
  const response = await fetchImpl(url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`the registry answered ${response.status}: ${text.slice(0, 500)}`);
  return { sent: true, status: response.status, body: text.slice(0, 500) };
}

async function main(argv) {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return argv.length ? 0 : 64;
  }
  const [repo, tag] = argv;
  if (argv.length !== 2 || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    process.stderr.write(HELP);
    return 64;
  }
  try {
    const result = await notify(repo, tag);
    process.stdout.write(result.sent ? `the registry queued ${repo}@${tag} (${result.status}): ${result.body}\n` : `didn't notify the registry: ${result.reason}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`notify-registry: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
