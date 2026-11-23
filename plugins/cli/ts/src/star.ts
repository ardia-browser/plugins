import { run } from "./browse/auth/run.ts";
import type { Said } from "./deliver.ts";
import { Float, type JsonObject } from "./json.ts";
import { which } from "./scripts/build.ts";
import { locked, recordingHome } from "./usage-store.ts";

const REPO = "mantrakp04/ardia";
const URL = `https://github.com/${REPO}`;
const SESSION = "ardia-star";
const GH_TIMEOUT_S = 20;
const BROWSE_TIMEOUT_S = 60;

async function succeeds(argv: string[], timeout: number, env?: Record<string, string>): Promise<boolean> {
  try {
    const ran = await run(argv, { timeout, ...(env === undefined ? {} : { env }) });
    return ran.code === 0;
  } catch {
    return false;
  }
}

function starWithGh(): Promise<boolean> {
  const gh = which("gh");
  if (!gh) return Promise.resolve(false);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  return succeeds([gh, "api", "--method", "PUT", `/user/starred/${REPO}`, "--silent"], GH_TIMEOUT_S, env);
}

function openInArdia(dataDir: string | undefined): Promise<boolean> {
  return succeeds([process.execPath, ...(dataDir ? ["--data-dir", dataDir] : []), "browse", "--session", SESSION, "open", URL, "--show"], BROWSE_TIMEOUT_S);
}

function markStarred(home: string, via: string): void {
  locked(home, (state: JsonObject) => {
    if (!state.has("star")) state.set("star", new Map());
    const star = state.get("star");
    if (!(star instanceof Map)) throw new TypeError("star");
    star.set("done_at", new Float(Date.now() / 1000));
    star.set("via", via);
  });
}

export async function runStar(dataDir: string | undefined): Promise<Said> {
  const home = recordingHome();
  let outcome: string;
  let status: number;
  let message: string;
  if (await starWithGh()) {
    [outcome, status] = ["gh", 0];
    message = `★ Starred github.com/${REPO} with the user's GitHub account (through gh). Thanks for the star!`;
  } else if (await openInArdia(dataDir)) {
    [outcome, status] = ["browser", 0];
    message = `Opened github.com/${REPO} in a new Ardia tab. Ask the user to click Star there; ardia doesn't click it for them.`;
  } else {
    [outcome, status] = ["manual", 1];
    message = `Couldn't star through gh or open Ardia. Ask the user to open ${URL} and click Star.`;
  }
  if (home !== undefined) {
    try {
      markStarred(home, outcome);
    } catch {}
  }
  return status === 0 ? { status, out: [message], err: [] } : { status, out: [], err: [message] };
}
