import { createReadStream } from "node:fs";

let release: (() => void) | undefined;

function routerGone(): void {
  process.kill(process.pid, "SIGKILL");
}

export function watchLifeline(fd: number): void {
  let released = false;
  const stream = createReadStream("", { fd, autoClose: false });
  stream.on("data", () => {});
  stream.on("error", () => {});
  stream.on("end", () => {
    if (!released) routerGone();
  });
  release = () => {
    released = true;
    stream.destroy();
  };
}

export function releaseLifeline(): void {
  release?.();
  release = undefined;
}
