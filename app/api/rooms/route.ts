import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { pickRandomLetter } from "../../../lib/game-rules";
import { hashPlayerToken, isValidPlayerId, isValidPlayerToken, readPlayerToken } from "../../../lib/player-auth";

type CreateRoomPayload = {
  playerId?: string;
  playerName?: string;
  categories?: string[];
};

const DEFAULT_CATEGORIES = [
  "Nome",
  "Lugar",
  "Objeto",
  "MSÉ",
  "PCH",
  "Palavra em Inglês",
  "Multimídia (filme, série, música)",
  "Comida",
];

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const db = (env as unknown as { DB: D1Database }).DB;

function cleanName(name?: string) {
  return name?.trim().slice(0, 24) || "Jogador";
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export async function POST(request: Request) {
  let payload: CreateRoomPayload;
  try {
    payload = (await request.json()) as CreateRoomPayload;
  } catch {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  const playerId = typeof payload.playerId === "string" ? payload.playerId.trim() : "";
  const playerToken = readPlayerToken(request);

  if (!isValidPlayerId(playerId) || !isValidPlayerToken(playerToken)) {
    return NextResponse.json({ error: "Identificação do jogador ausente." }, { status: 400 });
  }

  const tokenHash = await hashPlayerToken(playerToken);
  const existingPlayer = await db.prepare("SELECT auth_token_hash FROM players WHERE id = ?")
    .bind(playerId).first<{ auth_token_hash: string }>();
  if (existingPlayer?.auth_token_hash && existingPlayer.auth_token_hash !== tokenHash) {
    return NextResponse.json({ error: "Esta identificação já está em uso. Atualize a página." }, { status: 409 });
  }

  const categories = (Array.isArray(payload.categories) ? payload.categories : DEFAULT_CATEGORIES)
    .filter((category): category is string => typeof category === "string")
    .map((category) => category.trim().slice(0, 80))
    .filter(Boolean)
    .filter((category, index, list) => list.indexOf(category) === index)
    .slice(0, 16);
  const now = Date.now();
  const staleBefore = now - ROOM_TTL_MS;
  let code = makeCode();

  // As correções ensinadas ficam; somente salas abandonadas e suas rodadas são descartadas.
  await db.batch([
    db.prepare("DELETE FROM votes WHERE room_code IN (SELECT code FROM rooms WHERE updated_at < ?)").bind(staleBefore),
    db.prepare("DELETE FROM answers WHERE room_code IN (SELECT code FROM rooms WHERE updated_at < ?)").bind(staleBefore),
    db.prepare("DELETE FROM players WHERE room_code IN (SELECT code FROM rooms WHERE updated_at < ?)").bind(staleBefore),
    db.prepare("DELETE FROM rooms WHERE updated_at < ?").bind(staleBefore),
  ]);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const existing = await db.prepare("SELECT code FROM rooms WHERE code = ?").bind(code).first();
    if (!existing) break;
    code = makeCode();
  }

  await db.batch([
    db
      .prepare(
        "INSERT INTO rooms (code, host_id, categories_json, letter, round_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'lobby', ?, ?)",
      )
      .bind(code, playerId, JSON.stringify(categories.length ? categories : DEFAULT_CATEGORIES), pickRandomLetter(), crypto.randomUUID(), now, now),
    db
      .prepare(
        "INSERT INTO players (id, room_code, name, auth_token_hash, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room_code = excluded.room_code, name = excluded.name, auth_token_hash = excluded.auth_token_hash, updated_at = excluded.updated_at",
      )
      .bind(playerId, code, cleanName(typeof payload.playerName === "string" ? payload.playerName : undefined), tokenHash, now, now),
  ]);

  return NextResponse.json({ code });
}
