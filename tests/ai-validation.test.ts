import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { categoryPrompt, parseCategoryResults, validateCategoryBatch } from "../lib/ai-validation.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const approved = (id = 0, reason = "Nome proprio feminino") => ({ id, categoryMatch: "fits", verdict: "approved", reason });
const reply = (results: unknown[]) => Response.json({ choices: [{ message: { content: JSON.stringify({ results }) } }] });
const candidate = { category: "PCH", value: "silhueta" };
const run = (answers = [candidate], deadline = Date.now() + 20000) => validateCategoryBatch(answers, "S", "test-only", deadline);

test("category prompt distinguishes anatomy from appearance without banning a single answer", () => {
  const prompt = categoryPrompt("S");
  assert.match(prompt, /estrutura anatomica real/);
  assert.match(prompt, /erros simples de escrita/);
  assert.match(prompt, /nome regional nao prova/);
  assert.doesNotMatch(prompt, /silhueta/i);
});

test("letter-only and generic reasons require a category recheck", () => {
  for (const reason of ["Começa com S", "A palavra inicia com a letra S", "Começa com S e é válida", "Resposta válida", "Letra correta", "Pertence à categoria"]) {
    const [item] = parseCategoryResults({ results: [approved(0, reason)] }, 1);
    assert.equal(item.recheck, true, reason);
    assert.equal(item.result.score, 5);
    assert.equal(item.result.status, "needs_review");
  }
});

test("category verdicts must be explicit, consistent and matched by ID", () => {
  assert.throws(() => parseCategoryResults({ results: [{ ...approved(), categoryMatch: undefined }] }, 1));
  assert.equal(parseCategoryResults({ results: [{ ...approved(), categoryMatch: "does_not_fit" }] }, 1)[0].recheck, true);
  const results = parseCategoryResults({ results: [
    { id: 1, categoryMatch: "does_not_fit", verdict: "rejected", reason: "Contorno geral, nao estrutura anatomica" }, approved(),
  ] }, 2);
  assert.deepEqual(results.map(({ result }) => result.score), [10, 0]);
});

test("a short factual reason and regional uncertainty remain valid results", () => {
  assert.equal(parseCategoryResults({ results: [approved(0, "País")] }, 1)[0].recheck, false);
  const [item] = parseCategoryResults({ results: [{ id: 0, categoryMatch: "uncertain", verdict: "needs_review", reason: "Localidade regional nao confirmada" }] }, 1);
  assert.equal(item.recheck, false);
  assert.equal(item.result.score, 5);
});

test("lack of recognition is uncertainty, not evidence to reject a regional answer", () => {
  for (const reason of ["Não é um nome de localidade real reconhecida", "Não corresponde a parte do corpo humano conhecida", "Desconheço esse título", "Não encontrei essa cidade"]) {
    const [item] = parseCategoryResults({ results: [{ id: 0, categoryMatch: "does_not_fit", verdict: "rejected", reason }] }, 1);
    assert.equal(item.result.status, "needs_review", reason);
    assert.equal(item.result.score, 5);
    assert.equal(item.recheck, true);
  }
});

test("rejected typo gets a bounded second look while correct answers remain intact", async () => {
  const efforts: string[] = [];
  globalThis.fetch = async (_url, options) => {
    efforts.push(JSON.parse(String(options?.body)).reasoning_effort);
    return efforts.length === 1
      ? reply([{ id: 0, categoryMatch: "does_not_fit", verdict: "rejected", reason: "Nao corresponde a estrutura anatomica" }])
      : reply([approved(0, "Pescoço: regiao entre a cabeca e o tronco")]);
  };
  const result = await validateCategoryBatch([{ category: "PCH", value: "Pescosso" }], "P", "test-only", Date.now() + 20000);
  assert.equal(result[0].score, 10);
  assert.deepEqual(efforts, ["medium", "high"]);
});

test("only weak answers are rechecked and good results keep their original indexes", async () => {
  const requests: Array<{ messages: Array<{ content: string }>; reasoning_effort: string }> = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push(body);
    if (requests.length === 1) return reply([approved(), approved(1, "Começa com S")]);
    return reply([{ id: 0, categoryMatch: "does_not_fit", verdict: "rejected", reason: "Contorno, nao parte anatomica" }]);
  };
  const results = await run([{ category: "Nome", value: "Sabrina" }, candidate]);
  assert.deepEqual(results.map((result) => result.score), [10, 0]);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].messages[1].content), [{ id: 0, ...candidate }]);
  assert.equal(requests[0].reasoning_effort, "medium");
  assert.match(requests[1].messages[0].content, /segunda conferencia/);
});

test("a second weak response cannot become ten points or trigger an endless retry", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply([approved(0, "Começa com S")]); };
  assert.equal((await run())[0].score, 5);
  assert.equal(calls, 2);
});

test("failed recheck preserves good answers and leaves the uncertain one provisional", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? reply([approved(), approved(1, "Começa com S")]) : new Response(null, { status: 429 });
  assert.deepEqual((await run([{ category: "Nome", value: "Sabrina" }, candidate])).map((result) => result.score), [10, 5]);
  assert.equal(calls, 2);
});

test("malformed category output followed by outage stays uncertain, not school-approved", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? reply([{ id: 0, verdict: "approved", reason: "Começa com S" }]) : new Response(null, { status: 503 });
  assert.equal((await run())[0].status, "needs_review");
  assert.equal(calls, 2);
});

test("transport failure still uses the second model and a valid verdict", async () => {
  const models: string[] = [];
  globalThis.fetch = async (_url, options) => {
    models.push(JSON.parse(String(options?.body)).model);
    return models.length === 1 ? new Response(null, { status: 429 }) : reply([approved(0, "Regiao anatomica")]);
  };
  assert.equal((await run())[0].score, 10);
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("expired budget makes no further provider call", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply([approved()]); };
  await assert.rejects(run([candidate], Date.now() - 1), { name: "ValidationTimeout|ValidationTimeout" });
  assert.equal(calls, 0);
});
