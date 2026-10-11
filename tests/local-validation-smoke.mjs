import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2] || "http://localhost:3001";
assert.match(origin, /^http:\/\/localhost:\d+$/);
if (!process.argv.includes("--live")) throw new Error("Requires --live: this exercises the configured local Groq service.");
const playerId = randomUUID();
const token = randomUUID();
const cases = [
  ["Nome", "Sabrina", 10], ["Lugar", "Siria", 10], ["Objeto", "Sapato", 10], ["MSÉ", "Sensata", 10],
  ["PCH", "silhueta", 0], ["Palavra em Inglês", "seal", 10],
  ["Multimídia (filme, série, música)", "Sol nascente", 10], ["Comida", "salada", 10],
];
let code;
async function post(path, data) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-player-token": token },
    body: JSON.stringify({ playerId, ...data }), signal: AbortSignal.timeout(40000),
  });
  assert.equal(response.status, 200, `Unexpected HTTP status for ${data.action || "create"}`);
  return response.json();
}
try {
  ({ code } = await post("/api/rooms", { playerName: "Conferencia sintetica", categories: cases.map(([category]) => category) }));
  const path = `/api/rooms/${code}`;
  const response = await fetch(`${origin}${path}?playerId=${playerId}`, { headers: { "x-player-token": token }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  let room = await response.json();
  room = await post(path, { action: "letter", roundId: room.roundId, letter: "S" });
  room = await post(path, { action: "start", roundId: room.roundId });
  for (const [category, value] of cases) {
    await post(path, { action: "answer", roundId: room.roundId, category, value, answerUpdatedAt: Date.now() });
  }
  const started = Date.now();
  room = await post(path, { action: "stop", roundId: room.roundId });
  console.log(JSON.stringify({ status: room.status, durationWithGraceMs: Date.now() - started,
    score: room.podium[0].score, answers: room.answers.map(({ category, value, score, validationReason }) => ({ category, value, score, validationReason })) }));
  assert.equal(room.status, "review");
  assert.equal(room.answers.length, 8);
  for (const [category, value, score] of cases) {
    const answer = room.answers.find((item) => item.category === category);
    assert.equal(answer.value, value);
    assert.equal(answer.score, score, category);
    assert.doesNotMatch(answer.validationReason, /modo escolar|IA indisponivel/i);
  }
  assert.equal(room.podium[0].score, 70);
} finally {
  // This ID belongs only to the synthetic room created above, never the user's room.
  if (code) await post(`/api/rooms/${code}`, { action: "leave" });
}
