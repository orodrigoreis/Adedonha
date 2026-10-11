import { validateCategoryBatch } from "../lib/ai-validation.ts";

if (!process.argv.includes("--live") || !process.env.GROQ_API_KEY) {
  throw new Error("Requires --live and an existing server-side GROQ_API_KEY; never put the key in arguments.");
}

// Synthetic public vocabulary only. Does not read or change any room or student data.
const rounds = [
  { letter: "S", cases: [
    ["Nome", "Sabrina", [10]], ["Lugar", "Siria", [10]],
    ["Objeto", "Sapato", [10]], ["MSÉ", "Sensata", [10]],
    ["PCH", "silhueta", [0]], ["Palavra em Inglês", "seal", [10]],
    ["Multimídia (filme, série, música)", "Sol nascente", [10]], ["Comida", "salada", [10]],
    ["PCH", "sombra", [0]], ["PCH", "sobrancelha", [10]], ["PCH", "sacro", [10]],
    ["Objeto", "saudade", [0]], ["Lugar", "sapato", [0]], ["Comida", "sabonete", [0]],
    ["Palavra em Inglês", "sun", [10]], ["Nome", "Sérgio", [10]],
  ] },
  { letter: "P", cases: [
    ["Nome", "Patrícia", [10]], ["Lugar", "Pernanbuco", [10]],
    ["PCH", "Pescosso", [10]], ["Palavra em Inglês", "Peaple", [10]],
    ["Multimídia (filme, série, música)", "Preucurando Nemo", [10]], ["Comida", "Panqueca", [10]],
    ["MSÉ", "Professora", [10]], ["Objeto", "Perfume", [10]],
  ] },
  { letter: "C", cases: [
    ["Lugar", "Camela", [5, 10]], ["PCH", "camisa", [0]], ["PCH", "coração", [10]],
    ["Objeto", "Cadeira", [10]], ["Comida", "Cuscuz", [10]], ["Nome", "Caio", [10]],
    ["MSÉ", "Curiosa", [10]], ["Palavra em Inglês", "Cat", [10]],
    ["Multimídia (filme, série, música)", "Central do Brasil", [10]],
  ] },
];
let passed = 0;
let total = 0;
for (const round of rounds) {
  const started = Date.now();
  const candidates = round.cases.map(([category, value]) => ({ category, value }));
  const results = await validateCategoryBatch(candidates, round.letter, process.env.GROQ_API_KEY, started + 20000);
  const rows = results.map((result, index) => {
    const ok = round.cases[index][2].includes(result.score);
    passed += Number(ok); total++;
    return { ...candidates[index], ...result, expected: round.cases[index][2], passed: ok };
  });
  console.log(JSON.stringify({ letter: round.letter, durationMs: Date.now() - started, rows }));
}
console.log(JSON.stringify({ passed, total, evaluation: "One small live sample, not an accuracy guarantee" }));
if (passed !== total) process.exitCode = 1;
