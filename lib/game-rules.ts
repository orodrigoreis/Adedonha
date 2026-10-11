export type ValidationResult = {
  score: number;
  status: "approved" | "rejected" | "needs_review";
  reason: string;
};

export const ROUND_DURATION_SECONDS = 4 * 60;
export const MAX_ANSWER_LENGTH = 80;
export const ANSWER_GRACE_MS = 4000;

export function parseAIResults(input: unknown, count: number): ValidationResult[] {
  const results = input && typeof input === "object" && "results" in input ? input.results : null;
  if (!Array.isArray(results) || results.length !== count) throw new Error("Lista de vereditos incompleta");
  const byId = new Map<number, ValidationResult>();
  for (const item of results) {
    if (!item || !Number.isInteger(item.id) || item.id < 0 || item.id >= count || byId.has(item.id)
      || !["approved", "rejected", "needs_review"].includes(item.verdict)
      || typeof item.reason !== "string" || !item.reason.trim()) throw new Error("Veredito invalido");
    byId.set(item.id, {
      score: item.verdict === "approved" ? 10 : item.verdict === "rejected" ? 0 : 5,
      status: item.verdict,
      reason: `IA: ${item.reason.trim().slice(0, 120)}`,
    });
  }
  return Array.from({ length: count }, (_, id) => byId.get(id)!);
}

export function applyDuplicateScores(answers: Array<{ category: string; value: string }>, results: ValidationResult[]) {
  const keys = answers.map((answer) => JSON.stringify([normalize(answer.category), normalize(answer.value)]));
  const counts = new Map<string, number>();
  keys.forEach((key, index) => {
    if (answers[index].value.trim() && results[index].status !== "rejected") counts.set(key, (counts.get(key) || 0) + 1);
  });
  return results.map((result, index) => result.status !== "rejected" && (counts.get(keys[index]) || 0) > 1
    ? { ...result, score: 5, reason: `${result.reason} · resposta repetida` }
    : result);
}

export function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function isLikelySameAnswer(value: string, candidate: string) {
  const expected = normalize(value);
  const found = normalize(candidate);
  if (!expected || !found) return false;
  if (expected === found) return true;
  const allowedErrors = expected.length >= 12 ? 3 : expected.length >= 6 ? 2 : 1;
  return editDistance(expected, found) <= allowedErrors;
}

export function deterministicValidation(value: string, letter: string): ValidationResult | null {
  const cleaned = value.trim();
  if (!cleaned) return { score: 0, status: "rejected", reason: "Em branco" };
  if (normalize(cleaned).charAt(0).toUpperCase() !== letter) {
    return { score: 0, status: "rejected", reason: `Não começa com ${letter}` };
  }
  return null;
}

export function fallbackValidation(value: string, letter: string): ValidationResult {
  return deterministicValidation(value, letter) || {
    score: 10,
    status: "approved",
    reason: "Aceita pelo modo escolar (IA indisponível)",
  };
}

export function pickRandomLetter(currentLetter = "", random = Math.random) {
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((letter) => letter !== currentLetter.toUpperCase());
  const index = Math.min(Math.floor(random() * letters.length), letters.length - 1);
  return letters[Math.max(0, index)];
}
