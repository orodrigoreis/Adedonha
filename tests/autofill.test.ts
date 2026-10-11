import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { generateAutofill, parseGeneratedAnswers } from "../lib/autofill.ts";
import { emptyAutofillUpdates } from "../lib/autofill-client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const categories = [
  "Nome",
  "Lugar",
  "Objeto",
  "MSÉ",
  "PCH",
  "Palavra em Inglês",
  "Multimídia (filme, série, música)",
  "Comida",
];

test("standard suggestions cover all categories for M without a provider or credential", async () => {
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request");
  };
  const result = await generateAutofill(categories, "M");
  assert.equal(Object.keys(result.answers).length, categories.length);
  assert.deepEqual(result.unfilled, []);
  assert.equal(result.answers.PCH, "Mão");
  assert.equal(result.answers["Palavra em Inglês"], "Moon");
});

test("unknown combinations remain empty rather than inventing a word", async () => {
  const result = await generateAutofill(
    ["Nome", "PCH", "Categoria personalizada"],
    "K",
  );
  assert.equal(result.answers.Nome, "Karen");
  assert.deepEqual(result.unfilled, ["PCH", "Categoria personalizada"]);
});

test("generated suggestions reject wrong initials, extra categories and oversized answers", () => {
  const result = parseGeneratedAnswers(
    {
      answers: [
        { category: "Animal", value: "Mico" },
        { category: "Lugar", value: "Brasil" },
        { category: "Nome", value: "M".repeat(81) },
        { category: "Comida", value: "Manga" },
      ],
    },
    ["Animal", "Lugar", "Nome"],
    "M",
  );
  assert.deepEqual({ ...result }, { Animal: "Mico" });
});

test("optional AI completes custom categories and failure preserves known suggestions", async () => {
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answers: [{ category: "Animal", value: "Mico" }],
            }),
          },
        },
      ],
    });
  assert.equal(
    (await generateAutofill(["Nome", "Animal"], "M", "test-only")).answers
      .Animal,
    "Mico",
  );
  globalThis.fetch = async () => {
    throw new Error("Provider unavailable");
  };
  const fallback = await generateAutofill(["Nome", "Animal"], "M", "test-only");
  assert.equal(fallback.answers.Nome, "Marina");
  assert.deepEqual(fallback.unfilled, ["Animal"]);
});

test("typing during generation wins over suggestions and extra categories are ignored", () => {
  assert.deepEqual(
    emptyAutofillUpdates(
      { Nome: "Manuel", Lugar: "Manaus", Comida: " " },
      { Nome: "Marina", Lugar: "México", Comida: "Macarrão", Animal: "Mico" },
      ["Nome", "Lugar", "Comida"],
      "M",
    ),
    [["Comida", "Macarrão"]],
  );
});
