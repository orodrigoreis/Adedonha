import assert from "node:assert/strict";
import test from "node:test";
import { AnswerDrafts, readJsonResponse, readRoom, RoomRequestError } from "../lib/room-client.ts";

test("HTTP 200 with empty, malformed or error JSON is never success", async () => {
  for (const body of ["", "{", "null", "[]", '{"error":"falhou"}']) {
    await assert.rejects(readJsonResponse(new Response(body)), RoomRequestError);
  }
  assert.deepEqual(await readJsonResponse(Response.json({ saved: true })), { saved: true });
  await assert.rejects(readJsonResponse(new Response("", { status: 403 })), (error: unknown) => error instanceof RoomRequestError && error.status === 403);
});

test("incomplete room snapshots cannot reach the game state", () => {
  for (const input of [null, {}, { code: "ABCDE" }, { code: "ABCDE", players: [] }]) assert.throws(() => readRoom(input));
});

test("acknowledging an earlier save preserves the complete newer draft", () => {
  const drafts = new AnswerDrafts();
  drafts.reset("ABCDE:one");
  const first = drafts.set("Nome", "Mari", 100);
  const last = drafts.set("Nome", "Marina", 100);
  assert.ok(last.version > first.version);
  drafts.acknowledge("ABCDE:one", "Nome", first.version);
  assert.equal(drafts.pending.get("Nome")?.value, "Marina");
  drafts.acknowledge("ABCDE:one", "Nome", last.version);
  assert.equal(drafts.pending.size, 0);
});

test("an old room acknowledgment cannot clear a new round's draft", () => {
  const drafts = new AnswerDrafts();
  drafts.reset("ABCDE:one");
  drafts.set("Nome", "Marina", 100);
  drafts.reset("ABCDE:two");
  const next = drafts.set("Nome", "Maria", 100);
  drafts.acknowledge("ABCDE:one", "Nome", next.version);
  assert.equal(drafts.pending.get("Nome")?.value, "Maria");
});
