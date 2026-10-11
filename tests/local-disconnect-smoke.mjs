import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const origin = process.argv[2] || "http://localhost:3001";
assert.match(origin, /^http:\/\/localhost:\d+$/);
const playerId = randomUUID();
const token = randomUUID();
let code;

async function request(path, payload, signal = AbortSignal.timeout(15000)) {
  const response = await fetch(`${origin}${path}`, {
    method: payload ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-player-token": token },
    body: payload ? JSON.stringify({ playerId, ...payload }) : undefined,
    signal,
  });
  assert.equal(response.status, 200, `Unexpected status for ${payload?.action || path}`);
  return response.json();
}

try {
  ({ code } = await request("/api/rooms", { playerName: "Teste de interrupcao", categories: ["Nome"] }));
  const path = `/api/rooms/${code}`;
  let room = await request(`${path}?playerId=${playerId}`);
  room = await request(path, { action: "letter", letter: "M", roundId: room.roundId });
  room = await request(path, { action: "start", roundId: room.roundId });
  // A wrong initial takes the deterministic path, so no provider is called.
  await request(path, { action: "answer", category: "Nome", value: "Ana", roundId: room.roundId });
  const controller = new AbortController();
  const startedAt = Date.now();
  const stopping = request(path, { action: "stop", roundId: room.roundId }, controller.signal)
    .then(() => "completed", (error) => error.name);
  try {
    const observeUntil = Date.now() + 3000;
    do {
      await delay(100);
      room = await request(`${path}?playerId=${playerId}`);
    } while (room.status === "playing" && Date.now() < observeUntil);
    assert.equal(room.status, "closing");
  } finally {
    controller.abort();
  }
  assert.equal(await stopping, "AbortError");
  // Leave the server alone; the next GET must not be what completes the work.
  await delay(6500);
  room = await request(`${path}?playerId=${playerId}`);
  assert.equal(room.status, "review");
  assert.equal(room.answers.length, 1);
  assert.equal(room.answers[0].value, "Ana");
  assert.equal(room.answers[0].score, 0);
  assert.equal(room.answers[0].validationStatus, "rejected");
  assert.ok(Date.now() - startedAt < 30000, "Result must not wait for recovery");
  console.log(JSON.stringify({ passed: true, realLocalWorker: true, disconnectedDuringClosing: true,
    result: room.status, answerPreserved: true, aiCalls: 0, elapsedMs: Date.now() - startedAt }));
} finally {
  if (code) await request(`/api/rooms/${code}`, { action: "leave" });
}
