import type { FileSink, Subprocess } from "bun";
import { codePoints } from "../../pystr.ts";
import { pyStrip } from "../../pylib/str.ts";
import { sleep } from "../cdp/cancel.ts";
import { navigate } from "../commands/core.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { need, normalizeUrl, parse } from "../commands/parse.ts";
import { currentOrNew } from "../commands/shared.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import type { Page } from "../state/page.ts";
import { Screencast } from "./screencast.ts";
import { activate, captureOf, releaseClaim } from "./store.ts";

export const FRAME_RATE = 25;
export const ENCODER_WAIT = 60;
export const STDERR_TAIL = 400;

export type Encoder = Subprocess<"pipe", "ignore", "pipe">;
export type Recording = { cast: Screencast; process: Encoder; path: string; pump: Promise<void>; halt: AbortController };

export function encoderArgv(ffmpeg: string, target: string): string[] {
  return [
    ffmpeg,
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(FRAME_RATE),
    "-c:v",
    "mjpeg",
    "-i",
    "-",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "1500k",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-pix_fmt",
    "yuv420p",
    target,
  ];
}

export function spawnEncoder(ffmpeg: string, target: string): Encoder {
  return Bun.spawn(encoderArgv(ffmpeg, target), { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
}

async function pump(cast: Screencast, stdin: FileSink, halt: AbortSignal): Promise<void> {
  try {
    for (;;) {
      await sleep(1 / FRAME_RATE, halt);
      const latest = cast.latest;
      if (latest !== null) {
        stdin.write(Buffer.from(latest[1], "base64"));
        await stdin.flush();
      }
    }
  } catch {
    return;
  }
}

export async function cmdRecord(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "record start <path.webm> [url] | stop | restart <path.webm> [url]");
  const action = args[0] as string;
  if (action === "stop" || action === "restart") {
    const stopped = await stopRecording(ctx);
    if (action === "stop") {
      if (!stopped) throw new BrowseError("No recording is running");
      return new Result({ path: stopped }, `✓ Recording saved to ${stopped}`);
    }
  }
  if (action !== "start" && action !== "restart") throw new Usage(`Unknown record action: ${action}`);
  need(args, 2, `record ${action} <path.webm> [url]`);
  const capture = captureOf(ctx.state);
  if (capture.recording !== null) throw new BrowseError("A recording is already running; stop it first");
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new BrowseError("record needs ffmpeg on PATH to encode WebM (brew install ffmpeg)");
  let page: Page;
  if (args.length > 2) {
    page = await currentOrNew(ctx);
    await navigate(ctx, page, normalizeUrl(args[2] as string));
  } else page = await ctx.state.page();
  await page.requireVisible();
  const cast = new Screencast(page);
  await activate(ctx, page, "record", async () => {
    try {
      await cast.start(ctx.state);
    } catch (error) {
      if (error instanceof Gated) throw error.during("record start");
      throw error;
    }
  });
  const target = ctx.path(args[1] as string);
  let encoder: Encoder;
  try {
    encoder = spawnEncoder(ffmpeg, target);
  } catch (error) {
    await cast.stop(ctx.state);
    releaseClaim(ctx, page.targetId, "record");
    throw error;
  }
  const halt = new AbortController();
  capture.recording = { cast, process: encoder, path: args[1] as string, pump: pump(cast, encoder.stdin, halt.signal), halt };
  ctx.state.leases.add("record");
  return new Result({ path: args[1], started: true }, `✓ Recording started (${args[1]})`);
}

function finished(process: Encoder, seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), seconds * 1000);
    process.exited.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

async function closeEncoder(process: Encoder): Promise<void> {
  try {
    await process.stdin.end();
  } catch {}
  if (!(await finished(process, ENCODER_WAIT))) {
    process.kill();
    throw new BrowseError(`ffmpeg didn't finish the WebM in ${ENCODER_WAIT} s`);
  }
  if (process.exitCode !== 0) {
    const said = codePoints(await new Response(process.stderr).text()).slice(-STDERR_TAIL).join("");
    throw new BrowseError(`ffmpeg failed: ${pyStrip(said)}`);
  }
}

export async function stopRecording(ctx: Ctx): Promise<string | null> {
  const capture = captureOf(ctx.state);
  const recording = capture.recording;
  capture.recording = null;
  if (recording === null) return null;
  ctx.state.leases.delete("record");
  try {
    releaseClaim(ctx, recording.cast.page.targetId, "record");
    recording.halt.abort();
    await recording.pump;
    await recording.cast.stop(ctx.state);
  } finally {
    await closeEncoder(recording.process);
  }
  return recording.path;
}

register("record", cmdRecord);
