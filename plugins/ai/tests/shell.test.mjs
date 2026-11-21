import { test } from "node:test";
import assert from "node:assert/strict";
import { applyShell } from "../page/src/shellState.ts";

const thread = (id, over = {}) => ({ id, title: id, status: "idle", updatedAt: "2026-11-17T10:00:00Z", archivedAt: null, deletedAt: null, ...over });

test("an authoritative snapshot replaces the list; an enrichment snapshot merges", () => {
  let s = applyShell(new Map(), { kind: "snapshot", snapshot: { threads: [thread("a"), thread("b")], projects: [{ id: "p1" }] } });
  assert.deepEqual([...s.threads.keys()], ["a", "b"]);
  assert.equal(s.projectId, "p1");
  s = applyShell(s.threads, { kind: "snapshot", resolvedRepositoryIdentityRoots: [], snapshot: { threads: [], projects: [] } });
  assert.deepEqual([...s.threads.keys()], ["a", "b"]);
  s = applyShell(s.threads, { kind: "snapshot", snapshot: { threads: [thread("c")], projects: [] } });
  assert.deepEqual([...s.threads.keys()], ["c"]);
});

test("updates upsert, archive marks archived, removal and deletion drop", () => {
  let s = applyShell(new Map(), { kind: "snapshot", snapshot: { threads: [thread("a")], projects: [] } });
  s = applyShell(s.threads, { kind: "thread.updated", location: "active", thread: thread("b", { status: "running" }) });
  assert.equal(s.threads.get("b").status, "running");
  s = applyShell(s.threads, { kind: "thread.updated", location: "archive", thread: thread("a") });
  assert.equal(s.threads.get("a").archived, true);
  s = applyShell(s.threads, { kind: "thread.removed", threadId: "b" });
  assert.equal(s.threads.has("b"), false);
  s = applyShell(s.threads, { kind: "thread.updated", location: "active", thread: thread("a", { deletedAt: "2026-11-17T11:00:00Z" }) });
  assert.equal(s.threads.has("a"), false);
});

test("snoozed is only a future snooze; dates read from strings and Effect DateTimes", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const s = applyShell(new Map(), { kind: "snapshot", snapshot: { threads: [thread("a", { snoozedUntil: future }), thread("b", { snoozedUntil: "2020-01-01T00:00:00Z", updatedAt: { epochMilliseconds: 5 } })], projects: [] } });
  assert.equal(s.threads.get("a").snoozed, true);
  assert.equal(s.threads.get("b").snoozed, false);
  assert.equal(s.threads.get("b").updatedAt, 5);
});
