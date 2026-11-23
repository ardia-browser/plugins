import assert from "node:assert/strict";
import { constants } from "node:os";
import { test } from "bun:test";
import { BUILT_LIBC } from "./libc-loaded.ts";

type Raw = Record<string, (...args: unknown[]) => unknown>;

function raw(): Raw {
  const module = { exports: {} as Raw };
  process.dlopen(module, BUILT_LIBC);
  return module.exports;
}

const { EINVAL, EBADF } = constants.errno;
const AT_FDCWD = process.platform === "darwin" ? -2 : -100;

test("every native call refuses arguments it doesn't take", () => {
  const native = raw();
  assert.equal(native.peerUid?.(0, 1), -EINVAL);
  assert.equal(native.interruptsIgnored?.(1), -EINVAL);
  assert.equal(native.openAt?.(0, "x", 0, 0, 1), -EINVAL);
  assert.equal(native.connectAt?.(0, "x", 10, 1), -EINVAL);
  assert.equal(native.socketInfoAt?.(0, "x", 1), -EINVAL);
  assert.equal(native.strerror?.(1, 2), -EINVAL);
  assert.equal(native.writeSome?.(1, Buffer.alloc(0), 0), -EINVAL);
  assert.equal(native.peerUid?.(), -EINVAL);
});

test("the socket calls take a real folder descriptor, never the working-directory sentinel", () => {
  const native = raw();
  for (const fd of [AT_FDCWD, -1]) {
    assert.equal(native.socketInfoAt?.(fd, "k.sock"), -EBADF, String(fd));
    assert.equal(native.connectAt?.(fd, "k.sock", 10), -EBADF, String(fd));
  }
});
