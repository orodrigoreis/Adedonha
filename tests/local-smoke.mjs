import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2] || "http://localhost:3001";
assert.match(origin, /^http:\/\/localhost:\d+$/);
const host = { id: randomUUID(), token: randomUUID() };
const guest = { id: randomUUID(), token: randomUUID() };
let code;

async function request(path, player, payload, status = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: payload ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-player-token": player.token },
    body: payload ? JSON.stringify({ playerId: player.id, ...payload }) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status, `${payload?.action || path}: unexpected HTTP status`);
  return response.json();
}

// Exercise the actual local Worker and D1 without reaching round validation or AI.
try {
  ({ code } = await request("/api/rooms", host, { playerName: "Audit host", categories: ["Nome"] }));
  const path = `/api/rooms/${code}`;
  let room = await request(path, guest, { action: "join", playerName: "Audit guest" });
  assert.equal(room.players.length, 2);
  room = await request(path, host, { action: "start", roundId: room.roundId });
  assert.ok(room.roundEndsAt - Date.now() > 235000);
  assert.ok(room.roundEndsAt - Date.now() <= 240000);
  const version = Date.now();
  await request(path, host, { action: "answer", roundId: room.roundId, category: "Nome", value: "Marina", answerUpdatedAt: version });
  await request(path, host, { action: "answer", roundId: room.roundId, category: "Nome", value: "Mari", answerUpdatedAt: version - 1 });
  const own = await request(`${path}?playerId=${host.id}`, host);
  assert.equal(own.answers[0].value, "Marina");
  const other = await request(`${path}?playerId=${guest.id}`, guest);
  assert.equal(other.answers.length, 0);
  await request(path, guest, { action: "stop", roundId: room.roundId }, 403);
  await request(path, host, { action: "answer", roundId: "old-round", category: "Nome", value: "Maria" }, 409);
  await request(path, host, { action: "leave" });
  await request(`${path}?playerId=${guest.id}`, guest, undefined, 404);
  code = undefined;
  console.log(JSON.stringify({ passed: true, realLocalWorker: true, realLocalD1: true, aiCalls: 0,
    tested: ["create", "join", "four-minute-timer", "out-of-order-save", "answer-privacy", "host-authority", "old-round-rejection", "host-closes-room"] }));
} finally {
  if (code) await request(`/api/rooms/${code}`, host, { action: "leave" });
}
