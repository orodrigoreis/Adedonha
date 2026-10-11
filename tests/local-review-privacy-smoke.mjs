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
  assert.equal(response.status, status);
  if (status === 200 && path !== "/api/rooms") {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  return response.json();
}

try {
  ({ code } = await request("/api/rooms", host, { playerName: "Teste anfitriao", categories: ["Nome"] }));
  const path = `/api/rooms/${code}`;
  let room = await request(path, guest, { action: "join", playerName: "Teste participante" });
  room = await request(path, host, { action: "letter", letter: "M", roundId: room.roundId });
  room = await request(path, host, { action: "start", roundId: room.roundId });
  // Wrong initials avoid AI calls; manual adjustments exercise the full podium.
  for (const [player, value] of [[host, "Ana"], [guest, "Bruno"]]) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-player-token": player.token },
      body: JSON.stringify({ playerId: player.id, action: "answer", roundId: room.roundId, category: "Nome", value }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
  }
  room = await request(path, host, { action: "stop", roundId: room.roundId });
  assert.equal(room.status, "review");
  assert.equal(room.answers.length, 2);
  for (const [player, score] of [[host, 10], [guest, 5]]) {
    room = await request(path, host, { action: "override", roundId: room.roundId, targetPlayerId: player.id, category: "Nome", score });
  }
  const own = await request(`${path}?playerId=${guest.id}`, guest);
  assert.equal(own.answers.length, 1);
  assert.equal(own.answers[0].playerId, guest.id);
  assert.equal(own.answers[0].value, "Bruno");
  assert.equal(own.answers[0].score, 5);
  assert.doesNotMatch(JSON.stringify(own), /Ana/);
  assert.deepEqual(own.podium, room.podium);
  assert.deepEqual(own.podium.map((player) => player.score), [10, 5]);
  await request(`${path}?playerId=${host.id}`, guest, undefined, 403);
  console.log(JSON.stringify({ passed: true, participantAnswers: own.answers.length,
    hostAnswers: room.answers.length, fullPodium: true, spoofedHostDenied: true, aiCalls: 0 }));
} finally {
  if (code) {
    const response = await fetch(`${origin}/api/rooms/${code}`, {
      method: "POST", headers: { "content-type": "application/json", "x-player-token": host.token },
      body: JSON.stringify({ playerId: host.id, action: "leave" }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
  }
}
