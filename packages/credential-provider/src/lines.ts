export type LineSplitter = {
  push(chunk: Uint8Array): void;
  end(): void;
  readonly dropped: number;
};

const NEWLINE = 10;
const RETURN = 13;

export function splitLines(limitBytes: number, onLine: (line: Buffer) => void, onOversized?: () => void): LineSplitter {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  let dropped = 0;

  const reset = () => {
    parts = [];
    size = 0;
  };

  const keep = (piece: Uint8Array) => {
    if (skipping || piece.length === 0) return;
    if (size + piece.length > limitBytes) {
      reset();
      skipping = true;
      dropped++;
      onOversized?.();
      return;
    }
    parts.push(Buffer.from(piece));
    size += piece.length;
  };

  const emit = () => {
    if (!skipping) {
      const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
      onLine(line.length && line[line.length - 1] === RETURN ? line.subarray(0, line.length - 1) : line);
    }
    reset();
    skipping = false;
  };

  return {
    push(chunk) {
      let start = 0;
      let at: number;
      while ((at = chunk.indexOf(NEWLINE, start)) !== -1) {
        keep(chunk.subarray(start, at));
        emit();
        start = at + 1;
      }
      if (start < chunk.length) keep(chunk.subarray(start));
    },
    end() {
      if (size > 0 && !skipping) emit();
      reset();
      skipping = false;
    },
    get dropped() {
      return dropped;
    },
  };
}
