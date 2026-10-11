import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { hashPlayerToken } from "../lib/player-auth.ts";
import { readRoom } from "../lib/room-client.ts";
import type { AutofillResult } from "../lib/autofill.ts";

const sqlite = new DatabaseSync(":memory:");
let beforeWrite: (() => void) | undefined;
let providerCalls = 0;
let backgroundTasks: Promise<unknown>[] = [];
class Statement {
  sql: string;
  values: Array<string | number | null> = [];
  constructor(sql: string) { this.sql = sql; }
  bind(...values: Array<string | number | null>) { this.values = values; return this; }
  async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
  async run() {
    const hook = beforeWrite;
    beforeWrite = undefined;
    hook?.();
    const result = sqlite.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}
const DB = {
  prepare: (sql: string) => new Statement(sql),
  async batch(statements: Statement[]) {
    sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
Object.assign(globalThis, {
  __adedonhaTestEnv: { DB, GROQ_API_KEY: "test-only" },
  __adedonhaAfter: (task: Promise<unknown>) => { backgroundTasks.push(task); },
});
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env=globalThis.__adedonhaTestEnv", shortCircuit: true };
    if (specifier === "next/server") return { url: "data:text/javascript,export const NextResponse=Response;export const after=globalThis.__adedonhaAfter", shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { POST, GET } = await import("../app/api/rooms/[code]/route.ts");
const host = "da6ef401-0db8-41a7-9801-c7e8ba3ff9a3";
const guest = "388eb001-0532-4953-ad5c-b2c2453bf263";
const token = "a".repeat(32);
const hash = await hashPlayerToken(token);
const context = { params: Promise.resolve({ code: "ABCDE" }) };
const call = (payload: Record<string, unknown>, credential = token) => POST(new Request("http://localhost/api/rooms/ABCDE", {
  method: "POST", headers: { "Content-Type": "application/json", "x-player-token": credential },
  body: JSON.stringify({ playerId: host, roundId: "round-one", ...payload }),
}), context);
const guestToken = "b".repeat(32);
const guestHash = await hashPlayerToken(guestToken);
const roomFor = (id: string, credential = token) => GET(new Request(`http://localhost/api/rooms/ABCDE?playerId=${id}`, {
  headers: { "x-player-token": credential },
}), context);

function seedPrivateReview() {
  sqlite.exec("UPDATE rooms SET status = 'review'");
  sqlite.prepare("UPDATE players SET auth_token_hash = ? WHERE id = ?").run(guestHash, guest);
  const insert = sqlite.prepare("INSERT INTO answers (room_code, player_id, category, value, score, updated_at, validation_status, validation_reason) VALUES ('ABCDE', ?, ?, ?, ?, ?, 'approved', ?)");
  for (const [id, category, value, score] of [
    [host, "Nome", "Marina", 10], [host, "Lugar", "Mexico", 5],
    [guest, "Nome", "Maria", 5], [guest, "Lugar", "Maceio", 5],
  ] as const) insert.run(id, category, value, score, Date.now(), `Motivo privado: ${value}`);
}

beforeEach(() => {
  beforeWrite = undefined;
  providerCalls = 0;
  backgroundTasks = [];
  for (const table of ["votes", "answers", "players", "rooms", "learned_validations"]) sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  sqlite.prepare("INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ABCDE", host, JSON.stringify(["Nome", "Lugar"]), "M", "playing", Date.now() + 240000, Date.now(), Date.now(), "round-one");
  for (const id of [host, guest]) sqlite.prepare("INSERT INTO players (id, room_code, name, joined_at, updated_at, auth_token_hash) VALUES (?, 'ABCDE', ?, ?, ?, ?)").run(id, id === host ? "Host" : "Guest", Date.now(), Date.now(), hash);
  globalThis.fetch = async (_url, options) => {
    providerCalls++;
    const request = JSON.parse(String(options?.body));
    const answers = JSON.parse(request.messages[1].content) as Array<{ id: number }>;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: answers.map(({ id }) => ({ id, categoryMatch: "fits", verdict: "approved", reason: "Nome proprio de pessoa" })) }) } }] });
  };
});

afterEach(async () => { await Promise.allSettled(backgroundTasks); });

test("only the authenticated host can request autofill; guests and spoofed hosts cannot", async () => {
  assert.equal((await call({ action: "autofill", playerId: guest })).status, 403);
  assert.equal((await call({ action: "autofill" }, guestToken)).status, 403);
  assert.equal(providerCalls, 0);
  const response = await call({ action: "autofill" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json() as AutofillResult & { roundId: string };
  assert.equal(result.roundId, "round-one");
  assert.equal(result.answers.Nome, "Marina");
  assert.equal(result.answers.Lugar, "México");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM answers").get()?.count, 0);
});

test("autofill preserves saved answers and never fills a guest's sheet", async () => {
  await call({ action: "answer", category: "Nome", value: "Manuel" });
  const result = await (await call({ action: "autofill" })).json() as AutofillResult;
  assert.equal(result.answers.Nome, undefined);
  assert.equal(result.answers.Lugar, "México");
  assert.equal(sqlite.prepare("SELECT value FROM answers WHERE player_id = ?").get(host)?.value, "Manuel");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM answers WHERE player_id = ?").get(guest)?.count, 0);
});

test("every room's own host can autofill independently", async () => {
  sqlite.prepare("INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("FGHIJ", guest, JSON.stringify(["Nome", "Lugar"]), "B", "playing", Date.now() + 240000, Date.now(), Date.now(), "round-two");
  sqlite.prepare("UPDATE players SET room_code = 'FGHIJ', auth_token_hash = ? WHERE id = ?").run(guestHash, guest);
  const result = await POST(new Request("http://localhost/api/rooms/FGHIJ", {
    method: "POST", headers: { "content-type": "application/json", "x-player-token": guestToken },
    body: JSON.stringify({ action: "autofill", playerId: guest, roundId: "round-two" }),
  }), { params: Promise.resolve({ code: "FGHIJ" }) });
  assert.equal(result.status, 200);
  assert.equal((await result.json() as AutofillResult).answers.Nome, "Bruno");
  assert.equal((await call({ action: "autofill" })).status, 200);
});

test("autofill refuses an old round, an expired deadline and non-playing phases", async () => {
  assert.equal((await call({ action: "autofill", roundId: "old-round" })).status, 409);
  sqlite.exec("UPDATE rooms SET round_ends_at = 1");
  assert.equal((await call({ action: "autofill" })).status, 409);
  for (const status of ["lobby", "closing", "review"]) {
    sqlite.prepare("UPDATE rooms SET status = ?, round_ends_at = ?").run(status, Date.now() + 240000);
    assert.equal((await call({ action: "autofill" })).status, 409);
  }
  assert.equal(providerCalls, 0);
});

test("a round changed while generating cannot receive stale suggestions", async () => {
  sqlite.prepare("UPDATE rooms SET categories_json = ?").run(JSON.stringify(["Animal"]));
  globalThis.fetch = async () => {
    sqlite.exec("UPDATE rooms SET round_id = 'round-two'");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ answers: [{ category: "Animal", value: "Mico" }] }) } }] });
  };
  assert.equal((await call({ action: "autofill" })).status, 409);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM answers").get()?.count, 0);
});

test("unauthorized expired-room POST cannot close the round or call AI", async () => {
  sqlite.exec("UPDATE rooms SET round_ends_at = 1");
  assert.equal((await call({ action: "stop" }, "wrong")).status, 403);
  assert.equal(sqlite.prepare("SELECT status FROM rooms").get()?.status, "playing");
  assert.equal(providerCalls, 0);
});

test("last answer within the deadline grace is saved before validation", async () => {
  sqlite.prepare("UPDATE rooms SET round_ends_at = ?").run(Date.now() - 1000);
  assert.equal((await call({ action: "answer", category: "Nome", value: "Marina", answerUpdatedAt: Date.now() })).status, 200);
  assert.equal(sqlite.prepare("SELECT value FROM answers").get()?.value, "Marina");
  assert.equal(providerCalls, 0);
});

test("old round and out-of-order writes cannot replace current answers", async () => {
  const now = Date.now();
  await call({ action: "answer", category: "Nome", value: "Marina", answerUpdatedAt: now });
  await call({ action: "answer", category: "Nome", value: "Mari", answerUpdatedAt: now - 1 });
  assert.equal((await call({ action: "answer", roundId: "old-round", category: "Nome", value: "Maria" })).status, 409);
  assert.equal(sqlite.prepare("SELECT value FROM answers").get()?.value, "Marina");
});

test("round change between snapshot and write prevents a stale save", async () => {
  beforeWrite = () => { sqlite.exec("UPDATE rooms SET round_id = 'round-two'"); };
  assert.equal((await call({ action: "answer", category: "Nome", value: "Marina" })).status, 409);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM answers").get()?.count, 0);
});

test("long answers are rejected intact, not silently truncated", async () => {
  assert.equal((await call({ action: "answer", category: "Nome", value: "M".repeat(81) })).status, 400);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM answers").get()?.count, 0);
});

test("starting twice cannot extend the deadline", async () => {
  sqlite.exec("UPDATE rooms SET status = 'lobby', round_ends_at = NULL");
  assert.equal((await call({ action: "start" })).status, 200);
  const deadline = sqlite.prepare("SELECT round_ends_at FROM rooms").get()?.round_ends_at;
  assert.equal((await call({ action: "start" })).status, 409);
  assert.equal(sqlite.prepare("SELECT round_ends_at FROM rooms").get()?.round_ends_at, deadline);
});

test("one host's learned rejection does not affect another host's room", async () => {
  sqlite.prepare("INSERT INTO learned_validations VALUES (?, 'nome', 'marina', 0, ?)").run(guest, Date.now());
  await call({ action: "answer", category: "Nome", value: "Marina" });
  await call({ action: "answer", playerId: guest, category: "Nome", value: "Maria" });
  const result = readRoom(await (await call({ action: "stop" })).json());
  assert.equal(result.status, "review");
  assert.equal(result.answers.length, 4);
  assert.deepEqual(result.answers.filter((a: { value: string }) => a.value).map((a: { score: number }) => a.score), [10, 10]);
  assert.equal(providerCalls, 1);
  assert.equal((await call({ action: "override", category: "Nome", targetPlayerId: host, score: 10 })).status, 200);
  assert.equal(sqlite.prepare("SELECT score FROM learned_validations WHERE host_id = ?").get(guest)?.score, 0);
  assert.equal(sqlite.prepare("SELECT score FROM learned_validations WHERE host_id = ?").get(host)?.score, 10);
});

test("leaving as host removes room data; private answers stay private before review", async () => {
  await call({ action: "answer", playerId: guest, category: "Nome", value: "Marina" });
  const response = await GET(new Request(`http://test/api/rooms/ABCDE?playerId=${host}`, { headers: { "x-player-token": token } }), context);
  assert.equal(readRoom(await response.json()).answers.length, 0);
  assert.equal((await call({ action: "leave" })).status, 200);
  for (const table of ["rooms", "players", "answers", "votes"]) assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0);
});

test("the next letter clears old answers and rejects old manual adjustments", async () => {
  await call({ action: "answer", category: "Nome", value: "Marina" });
  sqlite.exec("UPDATE rooms SET status = 'review'");
  const next = readRoom(await (await call({ action: "letter", letter: "C" })).json());
  assert.notEqual(next.roundId, "round-one");
  assert.equal(next.answers.length, 0);
  assert.equal((await call({ action: "override", category: "Nome", targetPlayerId: host, score: 0 })).status, 409);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM learned_validations").get()?.count, 0);
});

test("identical answers share one AI candidate and both score five", async () => {
  await call({ action: "answer", category: "Nome", value: "Maria" });
  await call({ action: "answer", playerId: guest, category: "Nome", value: " maria " });
  let candidateCount = 0;
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    candidateCount += JSON.parse(JSON.parse(String(options?.body)).messages[1].content).length;
    return mockFetch(url, options);
  };
  const result = readRoom(await (await call({ action: "stop" })).json());
  assert.equal(candidateCount, 1);
  assert.deepEqual(result.answers.filter((answer) => answer.value).map((answer) => answer.score), [5, 5]);
});

test("provider failure preserves the school fallback and emits no answer text", async () => {
  await call({ action: "answer", category: "Nome", value: "Marina" });
  globalThis.fetch = async () => { providerCalls++; return new Response("private provider detail", { status: 429 }); };
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const result = readRoom(await (await call({ action: "stop" })).json());
    assert.equal(providerCalls, 2);
    assert.equal(result.answers.find((answer) => answer.value)?.score, 10);
    assert.match(warnings.join(""), /GroqHTTP429/);
    assert.doesNotMatch(warnings.join(""), /Marina|private provider detail/);
  } finally { console.warn = originalWarn; }
});

test("migration preserves old room data and unattributed learned corrections", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql") && !name.startsWith("0005")).sort()) {
      legacy.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
    }
    legacy.exec("INSERT INTO rooms VALUES ('ABCDE', 'host', '[]', 'C', 'lobby', NULL, 1, 1)");
    legacy.exec("INSERT INTO learned_validations VALUES ('lugar', 'camela', 10, 1)");
    legacy.exec(readFileSync(new URL("../drizzle/0005_round_integrity.sql", import.meta.url), "utf8"));
    assert.equal(String(legacy.prepare("SELECT round_id FROM rooms").get()?.round_id).length, 32);
    assert.equal(legacy.prepare("SELECT value_key FROM learned_validations WHERE host_id = ''").get()?.value_key, "camela");
  } finally { legacy.close(); }
});

test("category recheck reaches the stored score, without changing the student's answer", async () => {
  sqlite.prepare("UPDATE rooms SET letter = 'S', categories_json = ?").run(JSON.stringify(["PCH"]));
  await call({ action: "answer", category: "PCH", value: "silhueta" });
  globalThis.fetch = async () => {
    providerCalls++;
    const result = providerCalls === 1
      ? { id: 0, categoryMatch: "fits", verdict: "approved", reason: "Começa com S" }
      : { id: 0, categoryMatch: "does_not_fit", verdict: "rejected", reason: "Contorno visual, nao estrutura anatomica" };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: [result] }) } }] });
  };
  const room = readRoom(await (await call({ action: "stop" })).json());
  const answer = room.answers.find((item) => item.value);
  assert.equal(answer?.value, "silhueta");
  assert.equal(answer?.score, 0);
  assert.equal(answer?.validationStatus, "rejected");
  assert.equal(providerCalls, 2);
});

test("public evidence can confirm a title the AI leaves uncertain", async () => {
  const category = "Multimídia (filme, série, música)";
  sqlite.prepare("UPDATE rooms SET letter = 'S', categories_json = ?").run(JSON.stringify([category]));
  await call({ action: "answer", category, value: "Sol nascente" });
  let lookups = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://www.wikidata.org/")) {
      lookups++;
      return Response.json({ search: [{ label: "Sol Nascente", description: "telenovela brasileira" }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: [
      { id: 0, categoryMatch: "uncertain", verdict: "needs_review", reason: "Titulo nao confirmado" },
    ] }) } }] });
  };
  const room = readRoom(await (await call({ action: "stop" })).json());
  const answer = room.answers.find((item) => item.value);
  assert.equal(answer?.score, 10);
  assert.equal(answer?.validationReason, "Confirmada em fonte pública");
  assert.equal(lookups, 1);
});

test("closure is registered for background lifetime before any write and survives an aborted request", async () => {
  await call({ action: "answer", category: "Nome", value: "Marina" });
  const controller = new AbortController();
  beforeWrite = () => {
    assert.equal(backgroundTasks.length, 1);
    controller.abort();
  };
  const response = await POST(new Request("http://test/api/rooms/ABCDE", {
    method: "POST", signal: controller.signal,
    headers: { "Content-Type": "application/json", "x-player-token": token },
    body: JSON.stringify({ action: "stop", playerId: host, roundId: "round-one" }),
  }), context);
  await Promise.all(backgroundTasks);
  assert.equal(controller.signal.aborted, true);
  const room = readRoom(await response.json());
  assert.equal(room.status, "review");
  assert.equal(room.answers.find((answer) => answer.value)?.value, "Marina");
  assert.equal(room.answers.find((answer) => answer.value)?.score, 10);
});

test("polling recovers a stalled closure after one minute without reopening answer submission", async () => {
  await call({ action: "answer", category: "Nome", value: "Marina" });
  const endedAt = Date.now() - 61000;
  sqlite.prepare("UPDATE rooms SET status = 'closing', round_ends_at = ?, updated_at = ?").run(endedAt, endedAt);
  const response = await GET(new Request(`http://test/api/rooms/ABCDE?playerId=${host}`, { headers: { "x-player-token": token } }), context);
  const room = readRoom(await response.json());
  assert.equal(room.status, "review");
  assert.equal(room.roundEndsAt, endedAt);
  assert.equal(room.answers.find((answer) => answer.value)?.score, 10);
  assert.equal(backgroundTasks.length, 1);
  assert.equal((await call({ action: "answer", category: "Nome", value: "Maria" })).status, 409);
});

test("a closure still within its lease is not started a second time by polling", async () => {
  sqlite.prepare("UPDATE rooms SET status = 'closing', updated_at = ?").run(Date.now() - 30000);
  const response = await GET(new Request(`http://test/api/rooms/ABCDE?playerId=${host}`, { headers: { "x-player-token": token } }), context);
  assert.equal(readRoom(await response.json()).status, "closing");
  assert.equal(backgroundTasks.length, 0);
  assert.equal(providerCalls, 0);
});

test("simultaneous stop requests claim only one validation", async () => {
  await call({ action: "answer", category: "Nome", value: "Marina" });
  const responses = await Promise.all([call({ action: "stop" }), call({ action: "stop" })]);
  assert.ok(responses.some((response) => response.status === 200));
  await Promise.all(backgroundTasks);
  assert.equal(sqlite.prepare("SELECT status FROM rooms").get()?.status, "review");
  assert.equal(providerCalls, 1);
});

test("an obsolete closure cannot overwrite scores or finish a newer lease", async () => {
  await call({ action: "answer", category: "Nome", value: "Marina" });
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sqlite.exec("UPDATE rooms SET updated_at = updated_at + 60001");
    sqlite.exec("UPDATE answers SET score = 5, validation_status = 'needs_review', validation_reason = 'newer attempt'");
    return mockFetch(url, options);
  };
  const response = await call({ action: "stop" });
  assert.equal(readRoom(await response.json()).status, "closing");
  const answer = sqlite.prepare("SELECT value, score, validation_reason FROM answers WHERE value != ''").get();
  assert.equal(answer?.value, "Marina");
  assert.equal(answer?.score, 5);
  assert.equal(answer?.validation_reason, "newer attempt");
});

test("review sends only the participant's answers and reasons, while preserving the full podium", async () => {
  seedPrivateReview();
  const hostResponse = await roomFor(host);
  const hostRoom = readRoom(await hostResponse.json());
  const guestResponse = await roomFor(guest, guestToken);
  const guestRoom = readRoom(await guestResponse.json());
  assert.equal(hostRoom.answers.length, 4);
  assert.equal(guestRoom.answers.length, 2);
  assert.ok(guestRoom.answers.every((answer) => answer.playerId === guest));
  assert.doesNotMatch(JSON.stringify(guestRoom), /Marina|Mexico|Motivo privado: Marina/);
  assert.deepEqual(guestRoom.podium, hostRoom.podium);
  assert.deepEqual(guestRoom.podium.map((player) => player.score), [15, 10]);
  for (const response of [hostResponse, guestResponse]) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "X-Player-Token");
  }
});

test("changing the requested player ID cannot reveal another participant's review", async () => {
  seedPrivateReview();
  for (const response of [await roomFor(host, guestToken), await roomFor(guest), await roomFor("", guestToken)]) {
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /Marina|Mexico|Maria|Maceio/);
  }
});

test("host adjustments update the participant's private review and everyone's totals", async () => {
  seedPrivateReview();
  const response = await call({ action: "override", targetPlayerId: guest, category: "Nome", score: 10 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const hostRoom = readRoom(await response.json());
  const guestRoom = readRoom(await (await roomFor(guest, guestToken)).json());
  assert.equal(hostRoom.answers.length, 4);
  assert.equal(guestRoom.answers.length, 2);
  assert.equal(guestRoom.answers.find((answer) => answer.category === "Nome")?.score, 10);
  assert.deepEqual(guestRoom.podium, hostRoom.podium);
  assert.equal(guestRoom.podium.find((player) => player.id === guest)?.score, 15);
  assert.equal((await call({ action: "override", playerId: guest, targetPlayerId: host, category: "Nome", score: 0 }, guestToken)).status, 403);
});

test("even the host cannot read classmates' answers before review", async () => {
  seedPrivateReview();
  for (const status of ["playing", "closing"]) {
    sqlite.prepare("UPDATE rooms SET status = ?, updated_at = ?").run(status, Date.now());
    const room = readRoom(await (await roomFor(host)).json());
    assert.equal(room.answers.length, 2);
    assert.ok(room.answers.every((answer) => answer.playerId === host));
    assert.doesNotMatch(JSON.stringify(room.answers), /Maria|Maceio/);
  }
});

test("leaving during review does not return the remaining participants' answers", async () => {
  seedPrivateReview();
  const response = await call({ action: "leave", playerId: guest }, guestToken);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const room = readRoom(await response.json());
  assert.equal(room.answers.length, 0);
  assert.equal(room.podium.find((player) => player.id === host)?.score, 15);
  assert.equal((await roomFor(guest, guestToken)).status, 403);
});
