export type Player = { id: string; name: string };
export type Answer = { playerId: string; playerName?: string; category: string; value: string; score: number; validationStatus?: "approved" | "rejected" | "needs_review"; validationReason?: string };
export type Room = { code: string; roundId: string; hostId: string; categories: string[]; letter: string; status: "lobby" | "playing" | "closing" | "review"; roundEndsAt: number | null; players: Player[]; answers: Answer[]; podium: Array<Player & { score: number }> };

export class RoomRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = JSON.parse(await response.text()); } catch { data = null; }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error : "Não foi possível atualizar a sala.";
    throw new RoomRequestError(message, response.status);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || "error" in data) {
    throw new RoomRequestError("A sala enviou uma resposta incompleta. Tente novamente.", 502);
  }
  return data as Record<string, unknown>;
}

function isPlayer(value: unknown): value is Player {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string" && "name" in value && typeof value.name === "string");
}

export function readRoom(value: unknown): Room {
  const data = value as Room | null;
  if (!data || typeof data.code !== "string" || typeof data.roundId !== "string" || !data.roundId
    || typeof data.hostId !== "string" || typeof data.letter !== "string"
    || !["lobby", "playing", "closing", "review"].includes(data.status)
    || !(data.roundEndsAt === null || Number.isFinite(data.roundEndsAt))
    || !Array.isArray(data.categories) || !data.categories.every((item) => typeof item === "string")
    || !Array.isArray(data.players) || !data.players.every(isPlayer)
    || !Array.isArray(data.podium) || !data.podium.every((item) => isPlayer(item) && Number.isFinite(item.score))
    || !Array.isArray(data.answers) || !data.answers.every((item) => item && typeof item.playerId === "string"
      && typeof item.category === "string" && typeof item.value === "string" && [0, 5, 10].includes(item.score))) {
    throw new RoomRequestError("A sala enviou dados incompletos. Atualize a página.", 502);
  }
  return data;
}

export type Draft = { value: string; version: number };

export class AnswerDrafts {
  scope = "";
  pending = new Map<string, Draft>();
  private sequence = 0;

  reset(scope: string) { this.scope = scope; this.pending.clear(); this.sequence = 0; }
  set(category: string, value: string, now = Date.now()) {
    this.sequence = Math.max(now, this.sequence + 1);
    const draft = { value, version: this.sequence };
    this.pending.set(category, draft);
    return draft;
  }
  acknowledge(scope: string, category: string, version: number) {
    if (scope === this.scope && this.pending.get(category)?.version === version) this.pending.delete(category);
  }
}
