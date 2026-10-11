import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicValidation,
  fallbackValidation,
  isLikelySameAnswer,
  normalize,
  pickRandomLetter,
  ROUND_DURATION_SECONDS,
  parseAIResults,
  applyDuplicateScores,
} from "../lib/game-rules.ts";
import { hashPlayerToken, isValidPlayerId, isValidPlayerToken } from "../lib/player-auth.ts";

test("normaliza acentos, pontuação e espaços", () => {
  assert.equal(normalize("  Cidade de Deus! "), "cidade de deus");
  assert.equal(normalize("Coração"), "coracao");
});

test("reconhece respostas equivalentes com erros escolares simples", () => {
  assert.equal(isLikelySameAnswer("Procurando Nemo", "Preucurando Nemo"), true);
  assert.equal(isLikelySameAnswer("Cairo", "Cairo"), true);
  assert.equal(isLikelySameAnswer("Caixa", "Cairo"), false);
});

test("rejeita apenas vazio ou letra incompatível antes da correção", () => {
  assert.equal(deterministicValidation("", "C")?.score, 0);
  assert.equal(deterministicValidation("Bola", "C")?.score, 0);
  assert.equal(deterministicValidation("Cairo", "C"), null);
});

test("modo escolar não pune a turma quando a IA fica indisponível", () => {
  assert.deepEqual(fallbackValidation("Caixa", "C"), {
    score: 10,
    status: "approved",
    reason: "Aceita pelo modo escolar (IA indisponível)",
  });
});

test("credenciais de jogadores são validadas e protegidas antes de persistir", async () => {
  assert.equal(isValidPlayerId("não-é-um-uuid"), false);
  assert.equal(isValidPlayerId("da6ef401-0db8-41a7-9801-c7e8ba3ff9a3"), true);
  assert.equal(isValidPlayerToken("curta"), false);
  assert.equal(isValidPlayerToken("a".repeat(32)), true);
  const hash = await hashPlayerToken("a".repeat(32));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, "a".repeat(32));
});

test("sorteia a letra inicial e não repete a letra atual", () => {
  assert.equal(pickRandomLetter("", () => 0), "A");
  assert.equal(pickRandomLetter("C", () => 0), "A");
  assert.notEqual(pickRandomLetter("C", () => 0.999), "C");
});

test("mantém as rodadas com quatro minutos", () => {
  assert.equal(ROUND_DURATION_SECONDS, 240);
});

test("different real names are not duplicates; accents and spaces are", () => {
  const answers = ["Maria", "Marina", "Mão", " mão "].map((value) => ({ category: "Nome", value }));
  assert.deepEqual(applyDuplicateScores(answers, answers.map(() => ({ score: 10, status: "approved", reason: "ok" }))).map((result) => result.score), [10, 10, 5, 5]);
});

test("AI responses require unique in-range IDs, valid verdicts and reasons", () => {
  const valid = { id: 0, verdict: "approved", reason: "Valida" };
  for (const results of [[valid, valid], [{ ...valid, id: 1 }], [{ ...valid, reason: null }], [{ ...valid, verdict: "yes" }], [null]]) {
    assert.throws(() => parseAIResults({ results }, results.length));
  }
  assert.deepEqual(parseAIResults({ results: [{ ...valid, id: 1, verdict: "rejected" }, valid] }, 2).map((result) => result.score), [10, 0]);
});
