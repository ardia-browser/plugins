declare const Bun: { file(fd: number): { stream(): ReadableStream<Uint8Array> } };

let release: (() => void) | undefined;

function routerGone(): void {
  process.kill(process.pid, "SIGKILL");
}

export function watchLifeline(fd: number): void {
  let released = false;
  const reader = Bun.file(fd).stream().getReader();
  void (async () => {
    try {
      while (!(await reader.read()).done) {}
    } catch {
      return;
    }
    if (!released) routerGone();
  })();
  release = () => {
    released = true;
    reader.cancel().catch(() => {});
  };
}

export function releaseLifeline(): void {
  release?.();
  release = undefined;
}
