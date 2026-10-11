const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{24,128}$/;
const PLAYER_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function readPlayerToken(request: Request) {
  return request.headers.get("x-player-token")?.trim() || "";
}

export function isValidPlayerToken(token: string) {
  return TOKEN_PATTERN.test(token);
}

export function isValidPlayerId(playerId: string) {
  return PLAYER_ID_PATTERN.test(playerId);
}

export async function hashPlayerToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
