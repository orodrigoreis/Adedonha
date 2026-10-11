import { env } from "cloudflare:workers";
import { after, NextResponse } from "next/server";
import {
  deterministicValidation,
  fallbackValidation,
  isLikelySameAnswer,
  normalize,
  ROUND_DURATION_SECONDS,
  ANSWER_GRACE_MS,
  MAX_ANSWER_LENGTH,
  applyDuplicateScores,
  type ValidationResult,
} from "../../../../lib/game-rules";
import { hashPlayerToken, isValidPlayerId, isValidPlayerToken, readPlayerToken } from "../../../../lib/player-auth";
import { validateCategoryBatch } from "../../../../lib/ai-validation";
import { generateAutofill } from "../../../../lib/autofill";

type RouteContext = { params: Promise<{ code: string }> };
type ActionPayload = {
  action?: "join" | "leave" | "start" | "stop" | "answer" | "letter" | "override" | "autofill";
  playerId?: string;
  playerName?: string;
  targetPlayerId?: string;
  category?: string;
  value?: string;
  letter?: string;
  score?: number;
  answerUpdatedAt?: number;
  roundId?: string;
};

type RoundAnswer = {
  playerId: string;
  playerName: string;
  category: string;
  value: string;
  score: number;
  validationStatus: "approved" | "rejected" | "needs_review";
  validationReason: string;
};

type StoredAnswer = { player_id: string; category: string; value: string };
type LearnedValidation = { category_key: string; value_key: string; score: number };

const AI_BATCH_SIZE = 16;
const CLOSING_RECOVERY_MS = 60 * 1000;
const CLOSING_WORK_BUDGET_MS = 25000;
const VALIDATION_BUDGET_MS = 20000;
const PRIVATE_ROOM_RESPONSE = { headers: { "Cache-Control": "private, no-store", Vary: "X-Player-Token" } };
const db = (env as unknown as { DB: D1Database }).DB;

function cleanCode(code: string) { return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5); }
function cleanName(name?: string) { return name?.trim().slice(0, 24) || "Jogador"; }

async function authenticateMember(request: Request, code: string, playerId: string) {
  const member = await db.prepare("SELECT auth_token_hash FROM players WHERE id = ? AND room_code = ?")
    .bind(playerId, code).first<{ auth_token_hash: string }>();
  if (!member) return false;

  const token = readPlayerToken(request);
  if (!isValidPlayerToken(token)) return false;
  if (!member.auth_token_hash) {
    const tokenHash = await hashPlayerToken(token);
    const claim = await db.prepare("UPDATE players SET auth_token_hash = ? WHERE id = ? AND room_code = ? AND auth_token_hash = ''")
      .bind(tokenHash, playerId, code).run();
    return Boolean(claim.meta.changes);
  }
  return isValidPlayerToken(token) && await hashPlayerToken(token) === member.auth_token_hash;
}

async function wikidataConfirmsCategory(value: string, category: string, deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  const response = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(value)}&language=pt&uselang=pt&format=json&limit=5&origin=*`, {
    signal: AbortSignal.timeout(Math.min(3500, remaining)),
    headers: { "User-Agent": "AdedonhaStop/1.0 (educational word game; category verification)", Accept: "application/json" },
  });
  if (!response.ok) {
    console.warn(JSON.stringify({ event: "public_lookup_unavailable", reason: `HTTP${response.status}` }));
    return false;
  }
  const data = await response.json() as { search?: Array<{ label?: string; aliases?: string[]; description?: string }> };
  const normalizedCategory = normalize(category);
  const placeTerms = ["cidade", "municipio", "distrito", "bairro", "localidade", "aldeia", "vila", "praia", "rio", "estado", "pais", "regiao", "comuna", "povoado", "lugar"];
  const mediaTerms = ["filme", "serie", "cancao", "musica", "album", "jogo", "programa", "telenovela", "desenho", "obra"];
  const expectedTerms = normalizedCategory === "lugar" ? placeTerms : mediaTerms;

  return data.search?.some((item) => {
    const names = [item.label || "", ...(item.aliases || [])];
    const matchesName = names.some((name) => isLikelySameAnswer(value, name));
    const description = normalize(item.description || "");
    const descriptionWords = new Set(description.split(" "));
    return matchesName && expectedTerms.some((term) => descriptionWords.has(term));
  }) || false;
}

async function refineUncertainResult(answer: StoredAnswer, result: ValidationResult, deadline: number): Promise<ValidationResult> {
  if (result.status === "approved") return result;
  const category = normalize(answer.category);
  const canVerify = category === "lugar" || category.includes("multimidia");
  if (!canVerify) return result;

  try {
    if (await wikidataConfirmsCategory(answer.value, answer.category, deadline)) {
      return { score: 10, status: "approved", reason: "Confirmada em fonte pública" };
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "public_lookup_unavailable", reason: error instanceof Error ? error.name : "LookupError" }));
  }
  return result;
}

async function loadLearnedValidations(answers: StoredAnswer[], hostId: string) {
  const keys = [...new Map(answers.filter((answer) => answer.value.trim()).map((answer) => {
    const pair = [normalize(answer.category), normalize(answer.value)];
    return [JSON.stringify(pair), pair];
  })).values()];
  const result = new Map<string, number>();
  for (let offset = 0; offset < keys.length; offset += 30) {
    const batch = keys.slice(offset, offset + 30);
    const learned = await db.prepare(`SELECT category_key, value_key, score FROM learned_validations WHERE host_id = ? AND (${batch.map(() => "(category_key = ? AND value_key = ?)").join(" OR ")})`)
      .bind(hostId, ...batch.flat()).all<LearnedValidation>();
    learned.results.forEach((item) => result.set(`${item.category_key}:${item.value_key}`, Number(item.score)));
  }
  return result;
}

async function validateRound(code: string, letter: string, roundId: string, hostId: string, lease: number) {
  const startedAt = Date.now();
  const deadline = Math.min(startedAt + VALIDATION_BUDGET_MS, lease + CLOSING_WORK_BUDGET_MS);
  let fallbackCount = 0;
  const answers = await db.prepare("SELECT player_id, category, value FROM answers WHERE room_code = ?").bind(code).all<StoredAnswer>();
  const learned = await loadLearnedValidations(answers.results, hostId);
  const results: Array<ValidationResult | null> = answers.results.map((answer) => {
    const deterministic = deterministicValidation(answer.value, letter);
    if (deterministic) return deterministic;
    const learnedScore = learned.get(`${normalize(answer.category)}:${normalize(answer.value)}`);
    if (learnedScore === undefined) return null;
    return {
      score: learnedScore,
      status: learnedScore === 10 ? "approved" : "rejected",
      reason: "Aprendida após revisão do anfitrião",
    };
  });
  const grouped = new Map<string, { answer: StoredAnswer; indexes: number[] }>();
  answers.results.forEach((answer, index) => {
    if (results[index] !== null) return;
    const key = JSON.stringify([normalize(answer.category), normalize(answer.value)]);
    const group = grouped.get(key);
    if (group) group.indexes.push(index);
    else grouped.set(key, { answer, indexes: [index] });
  });
  const pending = [...grouped.values()];
  if (pending.length) {
    let validatedCount = 0;
    try {
      while (validatedCount < pending.length) {
        const batch = pending.slice(validatedCount, validatedCount + AI_BATCH_SIZE);
        const aiResults = await validateCategoryBatch(batch.map(({ answer }) => answer), letter,
          (env as unknown as { GROQ_API_KEY?: string }).GROQ_API_KEY, deadline);
        const refinedResults = await Promise.all(batch.map(({ answer }, batchIndex) => Date.now() < deadline
          ? refineUncertainResult(answer, aiResults[batchIndex], deadline) : aiResults[batchIndex]));
        batch.forEach(({ indexes }, batchIndex) => { indexes.forEach((index) => { results[index] = refinedResults[batchIndex]; }); });
        validatedCount += batch.length;
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "validation_fallback", reason: error instanceof Error ? error.name : "ProviderError" }));
      const remaining = pending.slice(validatedCount);
      const fallback = remaining.map(({ answer }) => fallbackValidation(answer.value, letter));
      remaining.forEach(({ indexes }, fallbackIndex) => { fallbackCount += indexes.length; indexes.forEach((index) => { results[index] = fallback[fallbackIndex]; }); });
    }
  }

  const scored = applyDuplicateScores(answers.results, results as ValidationResult[]);
  const validations = answers.results.map((answer, index) => ({ answer, result: scored[index] }));
  if (validations.length) await db.batch(validations.map(({ answer, result }) => db.prepare("UPDATE answers SET score = ?, validation_status = ?, validation_reason = ? WHERE room_code = ? AND player_id = ? AND category = ? AND EXISTS (SELECT 1 FROM rooms WHERE code = ? AND round_id = ? AND status = 'closing' AND updated_at = ?)").bind(result.score, result.status, result.reason, code, answer.player_id, answer.category, code, roundId, lease)));
  return { event: "round_validation_complete", durationMs: Date.now() - startedAt,
    answers: scored.length, filled: answers.results.filter((answer) => answer.value.trim()).length,
    uniqueCandidates: pending.length, fallbackCount,
    needsReview: scored.filter((result) => result.status === "needs_review").length };
}

function closeRound(code: string, letter: string, categories: string[], roundId: string, hostId: string) {
  // Register before the first write so a disconnect cannot strand a claimed round.
  const task = Promise.resolve().then(() => finishRound(code, letter, categories, roundId, hostId));
  after(task);
  return task;
}

async function finishRound(code: string, letter: string, categories: string[], roundId: string, hostId: string) {
  const now = Date.now();
  const transition = await db.prepare("UPDATE rooms SET status = 'closing', round_ends_at = MIN(round_ends_at, ?), updated_at = ? WHERE code = ? AND status = 'playing' AND round_id = ?").bind(now, now, code, roundId).run();
  if (!transition.meta.changes) {
    const recovery = await db.prepare("UPDATE rooms SET updated_at = ? WHERE code = ? AND status = 'closing' AND updated_at < ? AND round_id = ?").bind(now, code, now - CLOSING_RECOVERY_MS, roundId).run();
    if (!recovery.meta.changes) return;
    console.warn(JSON.stringify({ event: "round_closing_recovery" }));
  }
  await new Promise((resolve) => setTimeout(resolve, ANSWER_GRACE_MS + 100));
  if (categories.length) {
    await db.batch(categories.map((category) => db.prepare(
      "INSERT INTO answers (room_code, player_id, category, value, score, updated_at) SELECT ?, id, ?, '', 0, ? FROM players WHERE room_code = ? AND EXISTS (SELECT 1 FROM rooms WHERE code = ? AND round_id = ? AND status = 'closing' AND updated_at = ?) ON CONFLICT(room_code, player_id, category) DO NOTHING",
    ).bind(code, category, Date.now(), code, code, roundId, now)));
  }
  const summary = await validateRound(code, letter, roundId, hostId, now);
  const finished = await db.prepare("UPDATE rooms SET status = 'review', updated_at = ? WHERE code = ? AND status = 'closing' AND round_id = ? AND updated_at = ?").bind(Date.now(), code, roundId, now).run();
  if (finished.meta.changes) console.info(JSON.stringify(summary));
}

async function getRoom(code: string, playerId?: string, advance = true) {
  const room = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<Record<string, unknown>>();
  if (!room) return null;

  const now = Date.now();
  if (advance && ((room.status === "playing" && Number(room.round_ends_at) <= now) || (room.status === "closing" && Number(room.updated_at) < now - CLOSING_RECOVERY_MS))) {
    await closeRound(code, String(room.letter), JSON.parse(String(room.categories_json)) as string[], String(room.round_id), String(room.host_id));
    const refreshed = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<Record<string, unknown>>();
    if (refreshed) Object.assign(room, refreshed);
  }
  const players = await db.prepare("SELECT id, name FROM players WHERE room_code = ? ORDER BY joined_at ASC").bind(code).all<{ id: string; name: string }>();
  const isReview = room.status === "review";
  const canReviewAll = isReview && playerId === room.host_id;
  const answers = isReview
      ? await db.prepare(`SELECT a.player_id AS playerId, p.name AS playerName, a.category, a.value,
        a.score, a.validation_status AS validationStatus, a.validation_reason AS validationReason
        FROM answers a JOIN players p ON p.id = a.player_id AND p.room_code = a.room_code
        WHERE a.room_code = ? AND (? = 1 OR a.player_id = ?) ORDER BY p.joined_at, a.category`)
        .bind(code, canReviewAll ? 1 : 0, playerId || "").all<RoundAnswer>()
    : await db.prepare("SELECT player_id AS playerId, category, value, score, validation_status AS validationStatus, validation_reason AS validationReason FROM answers WHERE room_code = ? AND player_id = ?")
        .bind(code, playerId || "").all<RoundAnswer>();
  const playerOrder = new Map(players.results.map((player, index) => [player.id, index]));
  const categoryOrder = new Map((JSON.parse(String(room.categories_json)) as string[]).map((category, index) => [category, index]));
  answers.results.sort((left, right) =>
    (playerOrder.get(left.playerId) ?? Number.MAX_SAFE_INTEGER) - (playerOrder.get(right.playerId) ?? Number.MAX_SAFE_INTEGER)
    || (categoryOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER) - (categoryOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER));
  const totals = new Map<string, number>();
  if (isReview) {
    const scores = await db.prepare("SELECT player_id AS playerId, SUM(score) AS score FROM answers WHERE room_code = ? GROUP BY player_id")
      .bind(code).all<{ playerId: string; score: number }>();
    for (const score of scores.results) totals.set(score.playerId, Number(score.score));
  } else {
    for (const answer of answers.results) totals.set(answer.playerId, (totals.get(answer.playerId) || 0) + Number(answer.score));
  }
  const podium = players.results.map((player) => ({ ...player, score: totals.get(player.id) || 0 })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { code: room.code, roundId: room.round_id, hostId: room.host_id, categories: JSON.parse(String(room.categories_json)), letter: room.letter, status: room.status, roundEndsAt: room.round_ends_at, updatedAt: room.updated_at, players: players.results, answers: answers.results, podium };
}

export async function GET(request: Request, context: RouteContext) {
  const { code: rawCode } = await context.params;
  const playerId = new URL(request.url).searchParams.get("playerId") || undefined;
  const code = cleanCode(rawCode);
  const exists = await db.prepare("SELECT code FROM rooms WHERE code = ?").bind(code).first();
  if (!exists) return NextResponse.json({ error: "Sala não encontrada." }, { status: 404 });
  if (!playerId || !await authenticateMember(request, code, playerId)) {
    return NextResponse.json({ error: "Você não faz parte desta sala." }, { status: 403 });
  }
  const room = await getRoom(code, playerId);
  return room ? NextResponse.json(room, PRIVATE_ROOM_RESPONSE) : NextResponse.json({ error: "Sala não encontrada." }, { status: 404 });
}

export async function POST(request: Request, context: RouteContext) {
  const { code: rawCode } = await context.params;
  const code = cleanCode(rawCode);
  let payload: ActionPayload;
  try {
    payload = (await request.json()) as ActionPayload;
  } catch {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  const playerId = typeof payload.playerId === "string" ? payload.playerId.trim() : "";
  if (!isValidPlayerId(playerId)) return NextResponse.json({ error: "Identificação do jogador ausente." }, { status: 400 });
  const now = Date.now();

  if (!payload.action || !["join", "leave", "start", "stop", "answer", "letter", "override", "autofill"].includes(payload.action)) {
    return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  }
  if (payload.action !== "join" && !await authenticateMember(request, code, playerId)) {
    return NextResponse.json({ error: "Você não faz parte desta sala." }, { status: 403 });
  }
  const room = await getRoom(code, playerId, false);
  if (!room) return NextResponse.json({ error: "Sala não encontrada." }, { status: 404 });
  if (!["join", "leave"].includes(payload.action) && (!payload.roundId || payload.roundId !== room.roundId)) {
    return NextResponse.json({ error: "A rodada mudou. Atualize a página antes de continuar." }, { status: 409 });
  }

  if (payload.action === "autofill") {
    if (room.hostId !== playerId) return NextResponse.json({ error: "Só o anfitrião pode usar o autopreenchimento." }, { status: 403 });
    if (room.status !== "playing" || Number(room.roundEndsAt) <= now) {
      return NextResponse.json({ error: "O autopreenchimento só está disponível durante a rodada." }, { status: 409 });
    }
    const filled = new Set(room.answers.filter((answer) => answer.playerId === playerId && answer.value.trim()).map((answer) => answer.category));
    const categories = room.categories.filter((category: string) => !filled.has(category));
    const suggestions = await generateAutofill(categories, String(room.letter), (env as unknown as { GROQ_API_KEY?: string }).GROQ_API_KEY);
    const current = await getRoom(code, playerId, false);
    if (!current || current.hostId !== playerId || current.roundId !== room.roundId || current.status !== "playing" || Number(current.roundEndsAt) <= Date.now()) {
      return NextResponse.json({ error: "A rodada mudou ou terminou. Nenhuma sugestão foi aplicada." }, { status: 409 });
    }
    return NextResponse.json({ roundId: room.roundId, ...suggestions }, PRIVATE_ROOM_RESPONSE);
  }

  if (payload.action === "leave") {
    if (room.hostId === playerId) {
      await db.batch([
        db.prepare("DELETE FROM votes WHERE room_code = ?").bind(code),
        db.prepare("DELETE FROM answers WHERE room_code = ?").bind(code),
        db.prepare("DELETE FROM players WHERE room_code = ?").bind(code),
        db.prepare("DELETE FROM rooms WHERE code = ?").bind(code),
      ]);
      return NextResponse.json({ closed: true });
    }

    await db.batch([
      db.prepare("DELETE FROM votes WHERE room_code = ? AND (voter_id = ? OR target_player_id = ?)").bind(code, playerId, playerId),
      db.prepare("DELETE FROM answers WHERE room_code = ? AND player_id = ?").bind(code, playerId),
      db.prepare("DELETE FROM players WHERE id = ? AND room_code = ?").bind(playerId, code),
    ]);
    return NextResponse.json(await getRoom(code), PRIVATE_ROOM_RESPONSE);
  }

  if (payload.action === "join") {
    if (room.status !== "lobby") return NextResponse.json({ error: "Aguarde a próxima rodada para entrar." }, { status: 409 });
    const playerToken = readPlayerToken(request);
    if (!isValidPlayerToken(playerToken)) return NextResponse.json({ error: "Identificação do jogador ausente." }, { status: 400 });
    const tokenHash = await hashPlayerToken(playerToken);
    const existingPlayer = await db.prepare("SELECT room_code, auth_token_hash FROM players WHERE id = ?")
      .bind(playerId).first<{ room_code: string; auth_token_hash: string }>();
    if (existingPlayer?.auth_token_hash && existingPlayer.auth_token_hash !== tokenHash) {
      return NextResponse.json({ error: "Esta identificação já está em uso. Atualize a página." }, { status: 409 });
    }
    const count = await db.prepare("SELECT COUNT(*) AS total FROM players WHERE room_code = ?").bind(code).first<{ total: number }>();
    if (Number(count?.total || 0) >= 40 && existingPlayer?.room_code !== code) return NextResponse.json({ error: "A sala já está cheia." }, { status: 409 });
    const joined = await db.prepare("INSERT INTO players (id, room_code, name, auth_token_hash, joined_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rooms WHERE code = ? AND status = 'lobby') AND ((SELECT COUNT(*) FROM players WHERE room_code = ?) < 40 OR EXISTS (SELECT 1 FROM players WHERE id = ? AND room_code = ?)) ON CONFLICT(id) DO UPDATE SET room_code = excluded.room_code, name = excluded.name, auth_token_hash = excluded.auth_token_hash, updated_at = excluded.updated_at WHERE players.auth_token_hash = '' OR players.auth_token_hash = excluded.auth_token_hash")
      .bind(playerId, code, cleanName(typeof payload.playerName === "string" ? payload.playerName : undefined), tokenHash, now, now, code, code, playerId, code).run();
    if (!joined.meta.changes) return NextResponse.json({ error: "A sala mudou ou está cheia. Aguarde a próxima rodada." }, { status: 409 });
  }
  if (payload.action === "override") {
    if (room.hostId !== playerId) return NextResponse.json({ error: "Só o anfitrião pode ajustar a correção." }, { status: 403 });
    if (room.status !== "review") return NextResponse.json({ error: "A pontuação só pode ser ajustada após a correção automática." }, { status: 409 });
    const targetPlayerId = typeof payload.targetPlayerId === "string" ? payload.targetPlayerId.trim() : "";
    const category = typeof payload.category === "string" ? payload.category.slice(0, 80) : "";
    const score = payload.score;
    if (!targetPlayerId || !category || typeof score !== "number" || ![0, 5, 10].includes(score)) return NextResponse.json({ error: "Ajuste de pontuação inválido." }, { status: 400 });
    const answer = await db.prepare("SELECT value FROM answers WHERE room_code = ? AND player_id = ? AND category = ?")
      .bind(code, targetPlayerId, category).first<{ value: string }>();
    if (!answer) return NextResponse.json({ error: "Resposta não encontrada." }, { status: 404 });

    const status: ValidationResult["status"] = score === 10 ? "approved" : score === 0 ? "rejected" : "needs_review";
    const canLearn = Boolean(answer.value.trim()) && normalize(answer.value).charAt(0).toUpperCase() === room.letter;
    const learnedSuffix = canLearn && score !== 5 ? " · aprendida para próximas rodadas" : "";
    const statements = [
      db.prepare("UPDATE answers SET score = ?, validation_status = ?, validation_reason = ? WHERE room_code = ? AND player_id = ? AND category = ? AND EXISTS (SELECT 1 FROM rooms WHERE code = ? AND round_id = ? AND status = 'review')")
        .bind(score, status, `Ajustada pelo anfitrião${learnedSuffix}`, code, targetPlayerId, category, code, room.roundId),
    ];
    if (canLearn && score !== 5) {
      statements.push(db.prepare("INSERT INTO learned_validations (host_id, category_key, value_key, score, updated_at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0 ON CONFLICT(host_id, category_key, value_key) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at")
        .bind(playerId, normalize(category), normalize(answer.value), score, now));
    } else if (canLearn) {
      statements.push(db.prepare("DELETE FROM learned_validations WHERE host_id = ? AND category_key = ? AND value_key = ? AND changes() > 0")
        .bind(playerId, normalize(category), normalize(answer.value)));
    }
    const adjusted = await db.batch(statements);
    if (!adjusted[0].meta.changes) return NextResponse.json({ error: "A rodada mudou. Atualize a página." }, { status: 409 });
    return NextResponse.json(await getRoom(code, playerId), PRIVATE_ROOM_RESPONSE);
  }
  if (payload.action === "start" || payload.action === "stop" || payload.action === "letter") {
    if (room.hostId !== playerId) return NextResponse.json({ error: "Só quem criou a sala controla a rodada." }, { status: 403 });
    if (payload.action === "start") {
      if (room.status !== "lobby") return NextResponse.json({ error: "Escolha uma nova letra antes de iniciar outra rodada." }, { status: 409 });
      const started = await db.prepare("UPDATE rooms SET status = 'playing', round_ends_at = ?, updated_at = ? WHERE code = ? AND status = 'lobby' AND round_id = ?").bind(now + ROUND_DURATION_SECONDS * 1000, now, code, room.roundId).run();
      if (!started.meta.changes) return NextResponse.json({ error: "A rodada já começou." }, { status: 409 });
    }
    if (payload.action === "stop") {
      if (room.status !== "playing") return NextResponse.json({ error: "A rodada não está valendo." }, { status: 409 });
      await closeRound(code, String(room.letter), room.categories, String(room.roundId), String(room.hostId));
    }
    if (payload.action === "letter") {
      if (room.status !== "lobby" && room.status !== "review") return NextResponse.json({ error: "Espere a rodada terminar para trocar a letra." }, { status: 409 });
      const letter = typeof payload.letter === "string" ? payload.letter.trim().charAt(0).toUpperCase() : "";
      if (!letter || !/[A-Z]/.test(letter)) return NextResponse.json({ error: "Letra inválida." }, { status: 400 });
      const nextRoundId = crypto.randomUUID();
      const changed = await db.batch([
        db.prepare("UPDATE rooms SET letter = ?, round_id = ?, status = 'lobby', round_ends_at = NULL, updated_at = ? WHERE code = ? AND round_id = ? AND status IN ('lobby', 'review')").bind(letter, nextRoundId, now, code, room.roundId),
        db.prepare("DELETE FROM answers WHERE room_code = ? AND EXISTS (SELECT 1 FROM rooms WHERE code = ? AND round_id = ?)").bind(code, code, nextRoundId),
        db.prepare("DELETE FROM votes WHERE room_code = ? AND EXISTS (SELECT 1 FROM rooms WHERE code = ? AND round_id = ?)").bind(code, code, nextRoundId),
      ]);
      if (!changed[0].meta.changes) return NextResponse.json({ error: "A rodada mudou. Atualize a página." }, { status: 409 });
    }
  }
  if (payload.action === "answer") {
    if (typeof payload.category !== "string") return NextResponse.json({ error: "Categoria inválida." }, { status: 400 });
    const category = payload.category;
    if (!room.categories.includes(category)) return NextResponse.json({ error: "Categoria inválida." }, { status: 400 });
    const requestedUpdate = Number(payload.answerUpdatedAt);
    const answerUpdatedAt = Number.isFinite(requestedUpdate) ? Math.min(Math.max(requestedUpdate, now - 300000), now + 300000) : now;
    if (typeof payload.value !== "string" || payload.value.length > MAX_ANSWER_LENGTH) {
      return NextResponse.json({ error: `Use até ${MAX_ANSWER_LENGTH} caracteres por resposta.` }, { status: 400 });
    }
    const written = await db.prepare("INSERT INTO answers (room_code, player_id, category, value, score, updated_at) SELECT ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM rooms r JOIN players p ON p.room_code = r.code WHERE r.code = ? AND p.id = ? AND r.round_id = ? AND r.status IN ('playing', 'closing') AND r.round_ends_at + ? >= ?) ON CONFLICT(room_code, player_id, category) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.updated_at > answers.updated_at")
      .bind(code, playerId, category, payload.value, answerUpdatedAt, code, playerId, room.roundId, ANSWER_GRACE_MS, Date.now()).run();
    if (!written.meta.changes) {
      const current = await getRoom(code, playerId, false);
      if (!current || current.roundId !== room.roundId || !["playing", "closing"].includes(String(current.status)) || Number(current.roundEndsAt) + ANSWER_GRACE_MS < Date.now()) {
        return NextResponse.json({ error: "A rodada já terminou." }, { status: 409 });
      }
    }
    return NextResponse.json({ saved: true });
  }
  return NextResponse.json(await getRoom(code, playerId), PRIVATE_ROOM_RESPONSE);
}
