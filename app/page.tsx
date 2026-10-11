"use client";

import {
  FormEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  pickRandomLetter,
  ROUND_DURATION_SECONDS,
  MAX_ANSWER_LENGTH,
} from "../lib/game-rules";
import {
  AnswerDrafts,
  readJsonResponse,
  readRoom,
  RoomRequestError,
  type Answer,
  type Room,
} from "../lib/room-client";
import { emptyAutofillUpdates } from "../lib/autofill-client";

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

function getPlayerId() {
  const key = "adedonha-player-id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}

function getPlayerToken() {
  const key = "adedonha-player-token";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll(
    "-",
    "",
  );
  window.localStorage.setItem(key, created);
  return created;
}

function validationLabel(status?: Answer["validationStatus"]) {
  if (status === "approved") return "validada";
  if (status === "rejected") return "inválida";
  return "pontuação parcial";
}

function validationClass(status?: Answer["validationStatus"]) {
  if (status === "approved") return "status-good";
  if (status === "rejected") return "status-warn";
  return "status-muted";
}

export default function Home() {
  const [playerId, setPlayerId] = useState("");
  const [playerToken, setPlayerToken] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [secondsLeft, setSecondsLeft] = useState(ROUND_DURATION_SECONDS);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [autofilling, setAutofilling] = useState(false);
  const answersRef = useRef<Record<string, string>>({});
  const autofillInFlight = useRef(false);
  const [adjustingAnswer, setAdjustingAnswer] = useState("");
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const drafts = useRef(new AnswerDrafts());
  const saves = useRef(new Map<string, Promise<void>>());
  const roomRef = useRef<Room | null>(null);
  const pollInFlight = useRef(false);
  const roomLoadVersion = useRef(0);
  const activeRoomCode = room?.code;

  function acceptRoom(value: unknown) {
    const next = readRoom(value);
    const scope = `${next.code}:${next.roundId}`;
    const changedRound = drafts.current.scope !== scope;
    if (changedRound) {
      Object.values(saveTimers.current).forEach(clearTimeout);
      drafts.current.reset(scope);
    }
    // During play and closing, server snapshots must not replace local typing.
    if (changedRound || next.status === "review") {
      answersRef.current = Object.fromEntries(
        next.answers
          .filter((answer) => answer.playerId === playerId)
          .map((answer) => [answer.category, answer.value]),
      );
      setAnswers(answersRef.current);
    }
    roomRef.current = next;
    setRoom(next);
  }

  function clearRoom() {
    Object.values(saveTimers.current).forEach(clearTimeout);
    drafts.current.reset("");
    roomLoadVersion.current += 1;
    roomRef.current = null;
    answersRef.current = {};
    setRoom(null);
    setRoomCode("");
    setAnswers({});
  }

  const formattedTime =
    room?.status === "playing"
      ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
      : room?.status === "lobby"
        ? `${ROUND_DURATION_SECONDS / 60}:00`
        : "0:00";
  const isHost = room?.hostId === playerId;
  const reviewAnswers =
    room?.answers.filter((answer) => isHost || answer.playerId === playerId) ||
    [];
  const totalScore = useMemo(
    () => room?.podium.find((player) => player.id === playerId)?.score || 0,
    [room?.podium, playerId],
  );

  async function request<T = Room>(
    url: string,
    options?: RequestInit,
  ): Promise<T> {
    const headers = new Headers(options?.headers);
    if (playerToken) headers.set("X-Player-Token", playerToken);
    const response = await fetch(url, {
      ...options,
      headers,
      signal: options?.signal || AbortSignal.timeout(40000),
    });
    return (await readJsonResponse(response)) as T;
  }
  async function loadRoom(code: string, showErrors = true) {
    if (!showErrors && pollInFlight.current) return;
    if (!showErrors) pollInFlight.current = true;
    const requestVersion = ++roomLoadVersion.current;
    try {
      const data = await request(
        `/api/rooms/${code}?playerId=${encodeURIComponent(playerId)}`,
      );
      if (requestVersion !== roomLoadVersion.current) return;
      acceptRoom(data);
      setRoomCode(data.code);
      if (showErrors) setMessage("");
    } catch (error) {
      if (requestVersion !== roomLoadVersion.current) return;
      if (
        error instanceof RoomRequestError &&
        [403, 404].includes(error.status)
      ) {
        clearRoom();
        setMessage(
          error.status === 404
            ? "A sala foi encerrada pelo anfitrião."
            : "Sua conexão com esta sala terminou. Entre novamente.",
        );
        return;
      }
      if (showErrors)
        setMessage(
          error instanceof Error
            ? error.message
            : "Não foi possível abrir a sala.",
        );
    } finally {
      if (!showErrors) pollInFlight.current = false;
    }
  }
  async function createRoom() {
    if (!playerName.trim())
      return setMessage("Escreva seu nome para criar a sala.");
    setBusy(true);
    try {
      window.localStorage.setItem("adedonha-player-name", playerName.trim());
      const data = await request<{ code: string }>("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          playerName,
          categories: DEFAULT_CATEGORIES,
        }),
      });
      if (typeof data.code !== "string")
        throw new Error("A sala não retornou um código válido.");
      await loadRoom(data.code);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Não foi possível criar a sala.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (!playerName.trim()) return setMessage("Escreva seu nome para entrar.");
    if (code.length < 5)
      return setMessage("Digite o código de cinco letras da sala.");
    setBusy(true);
    try {
      window.localStorage.setItem("adedonha-player-name", playerName.trim());
      const data = await request(`/api/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", playerId, playerName }),
      });
      roomLoadVersion.current += 1;
      acceptRoom(data);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Não foi possível entrar na sala.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function roomAction(
    action: "start" | "stop" | "letter",
    extra: Record<string, string> = {},
  ) {
    if (!room) return;
    setBusy(true);
    try {
      if (action === "stop") await flushAll();
      roomLoadVersion.current += 1;
      const data = await request(`/api/rooms/${room.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          playerId,
          roundId: room.roundId,
          ...extra,
        }),
      });
      roomLoadVersion.current += 1;
      acceptRoom(data);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Não foi possível atualizar a rodada.",
      );
    } finally {
      setBusy(false);
    }
  }
  function persistAnswer(category: string): Promise<void> {
    const current = roomRef.current;
    const draft = drafts.current.pending.get(category);
    if (!current || !draft || !["playing", "closing"].includes(current.status))
      return Promise.resolve();
    const scope = drafts.current.scope;
    const key = `${scope}:${category}:${draft.version}`;
    const existing = saves.current.get(key);
    if (existing) return existing;
    const save = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (drafts.current.scope !== scope) return;
        try {
          const result = await request<{ saved: boolean }>(
            `/api/rooms/${current.code}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: AbortSignal.timeout(6000),
              body: JSON.stringify({
                action: "answer",
                playerId,
                roundId: current.roundId,
                category,
                value: draft.value,
                answerUpdatedAt: draft.version,
              }),
            },
          );
          if (result.saved !== true)
            throw new RoomRequestError(
              "Resposta não confirmada pela sala.",
              502,
            );
          drafts.current.acknowledge(scope, category, draft.version);
          return;
        } catch (error) {
          if (drafts.current.scope !== scope) return;
          if (
            attempt === 1 ||
            (error instanceof RoomRequestError && error.status < 500)
          )
            throw error;
        }
      }
    })().finally(() => saves.current.delete(key));
    saves.current.set(key, save);
    return save;
  }
  function saveAnswer(category: string, value: string) {
    answersRef.current = { ...answersRef.current, [category]: value };
    setAnswers(answersRef.current);
    drafts.current.set(category, value);
    clearTimeout(saveTimers.current[category]);
    saveTimers.current[category] = setTimeout(() => flushAnswer(category), 180);
  }
  function flushAnswer(category: string) {
    clearTimeout(saveTimers.current[category]);
    void persistAnswer(category).catch((error: unknown) =>
      setMessage(
        error instanceof Error
          ? error.message
          : "Não deu para salvar essa resposta agora.",
      ),
    );
  }
  async function flushAll() {
    Object.values(saveTimers.current).forEach(clearTimeout);
    await Promise.all([...drafts.current.pending.keys()].map(persistAnswer));
  }
  async function autofillAnswers() {
    const current = roomRef.current;
    if (
      !current ||
      current.hostId !== playerId ||
      current.status !== "playing" ||
      autofillInFlight.current
    )
      return;
    const scope = `${current.code}:${current.roundId}`;
    autofillInFlight.current = true;
    setAutofilling(true);
    setMessage("");
    try {
      await flushAll();
      const result = await request<{
        roundId: string;
        answers: Record<string, string>;
        unfilled: string[];
      }>(`/api/rooms/${current.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "autofill",
          playerId,
          roundId: current.roundId,
        }),
      });
      const active = roomRef.current;
      if (
        !active ||
        drafts.current.scope !== scope ||
        result.roundId !== current.roundId ||
        active.status !== "playing" ||
        Number(active.roundEndsAt) <= Date.now()
      )
        return;
      const updates = emptyAutofillUpdates(
        answersRef.current,
        result.answers,
        active.categories,
        active.letter,
      );
      for (const [category, value] of updates) saveAnswer(category, value);
      await flushAll();
      if (drafts.current.scope !== scope) return;
      const remaining = active.categories.filter(
        (category) => !answersRef.current[category]?.trim(),
      );
      setMessage(
        remaining.length
          ? `Preenchi ${updates.length} campo(s). Sem sugestão para: ${remaining.join(", ")}.`
          : "Respostas preenchidas. Você pode editar antes de encerrar a rodada.",
      );
    } catch (error) {
      if (drafts.current.scope === scope)
        setMessage(
          error instanceof Error
            ? error.message
            : "Não foi possível preencher as respostas.",
        );
    } finally {
      autofillInFlight.current = false;
      setAutofilling(false);
    }
  }
  async function leaveRoom() {
    if (!room) return;
    setBusy(true);
    try {
      await request(`/api/rooms/${room.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "leave", playerId }),
      });
      clearRoom();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Não foi possível sair da sala.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function adjustScore(answer: Answer, score: number) {
    if (!room || !isHost) return;
    const key = `${answer.playerId}-${answer.category}`;
    setAdjustingAnswer(key);
    try {
      const data = await request(`/api/rooms/${room.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "override",
          playerId,
          roundId: room.roundId,
          targetPlayerId: answer.playerId,
          category: answer.category,
          score,
        }),
      });
      roomLoadVersion.current += 1;
      acceptRoom(data);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Não foi possível ajustar a pontuação.",
      );
    } finally {
      setAdjustingAnswer("");
    }
  }

  function chooseNextLetter() {
    if (!room) return;
    void roomAction("letter", { letter: pickRandomLetter(room.letter) });
  }

  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setMessage("Código da sala copiado.");
    } catch {
      setMessage(`Código da sala: ${room.code}`);
    }
  }

  const refreshRoom = useEffectEvent((code: string) => {
    void loadRoom(code, false);
  });
  const flushPending = useEffectEvent(() => {
    void flushAll().catch(() =>
      setMessage("Há respostas pendentes. Confira sua conexão."),
    );
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPlayerId(getPlayerId());
      setPlayerToken(getPlayerToken());
      setPlayerName(window.localStorage.getItem("adedonha-player-name") || "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!room?.roundEndsAt || room.status !== "playing") {
      const reset = window.setTimeout(
        () => setSecondsLeft(ROUND_DURATION_SECONDS),
        0,
      );
      return () => window.clearTimeout(reset);
    }
    const update = () =>
      setSecondsLeft(
        Math.max(0, Math.ceil((room.roundEndsAt! - Date.now()) / 1000)),
      );
    const initial = window.setTimeout(update, 0);
    const interval = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [room?.roundEndsAt, room?.status]);
  useEffect(() => {
    if (!activeRoomCode || !playerId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") refreshRoom(activeRoomCode);
    };
    const visibility = () => {
      flushPending();
      refresh();
    };
    const interval = window.setInterval(refresh, 2500);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
    };
  }, [activeRoomCode, playerId, playerToken]);
  useEffect(
    () => () => Object.values(saveTimers.current).forEach(clearTimeout),
    [],
  );
  useEffect(() => {
    if (
      room?.status !== "closing" &&
      !(room?.status === "playing" && secondsLeft === 0)
    )
      return;
    flushPending();
  }, [room?.status, secondsLeft]);

  if (!room)
    return (
      <main className="min-h-screen bg-[#f5f1e8] px-4 py-10 text-[#211f1b] sm:px-6">
        <section className="mx-auto max-w-xl border border-[#cbb995] bg-[#fffaf0] p-6 shadow-[0_12px_28px_rgb(67_52_32_/_12%)] sm:p-8">
          <p className="text-xs font-bold uppercase text-[#8b4d2f]">
            Mesa online
          </p>
          <h1 className="mt-2 text-4xl font-black">Adedonha/Stop!</h1>
          <p className="mt-3 text-[#70685d]">
            Crie uma sala e compartilhe o código. Todo mundo joga a mesma letra,
            no mesmo tempo.
          </p>
          <label className="mt-6 block text-sm font-extrabold">
            Seu nome
            <input
              className="answer-input"
              disabled={!playerId || !playerToken}
              maxLength={24}
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="Ex.: Rodrigo"
            />
          </label>
          <button
            className="primary-button mt-4 w-full"
            disabled={busy || !playerId || !playerToken}
            onClick={createRoom}
          >
            Criar sala
          </button>
          <div className="my-6 border-t border-[#d9cbb4]" />
          <form onSubmit={joinRoom}>
            <label className="block text-sm font-extrabold">
              Código da sala
              <input
                className="answer-input uppercase"
                value={roomCode}
                onChange={(event) =>
                  setRoomCode(event.target.value.toUpperCase())
                }
                placeholder="ABCDE"
                maxLength={5}
              />
            </label>
            <button
              className="plain-button mt-4 w-full"
              disabled={busy || !playerId || !playerToken}
              type="submit"
            >
              Entrar na sala
            </button>
          </form>
          {message && (
            <p
              aria-live="polite"
              className="mt-4 text-sm font-bold text-[#9b2226]"
            >
              {message}
            </p>
          )}
        </section>
      </main>
    );

  return (
    <main className="min-h-screen bg-[#f5f1e8] text-[#211f1b]">
      <section className="border-b border-[#d9cbb4] bg-[#fffaf0]">
        <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-xs font-bold uppercase text-[#8b4d2f]">
              Sala {room.code}
            </p>
            <h1 className="mt-1 text-3xl font-black sm:text-5xl">
              Adedonha/Stop!
            </h1>
            <p className="mt-1 text-sm font-semibold text-[#70685d]">
              {room.players.length}{" "}
              {room.players.length === 1 ? "pessoa na sala" : "pessoas na sala"}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[460px]">
            <div className="border border-[#cbb995] bg-white px-3 py-3">
              <p className="text-xs font-bold uppercase text-[#6f6557]">
                Letra
              </p>
              <p className="text-4xl font-black text-[#005f73]">
                {room.letter}
              </p>
            </div>
            <div className="border border-[#cbb995] bg-white px-3 py-3">
              <p className="text-xs font-bold uppercase text-[#6f6557]">
                Tempo
              </p>
              <p className="text-4xl font-black text-[#9b2226]">
                {formattedTime}
              </p>
            </div>
            <div className="border border-[#cbb995] bg-white px-3 py-3">
              <p className="text-xs font-bold uppercase text-[#6f6557]">
                Pontos
              </p>
              <p className="text-4xl font-black text-[#386641]">{totalScore}</p>
            </div>
          </div>
        </div>
      </section>
      <section className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {isHost && room.status === "lobby" && (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => roomAction("start")}
              >
                Começar rodada
              </button>
            )}
            {isHost && room.status === "playing" && (
              <button
                className="plain-button"
                disabled={busy}
                onClick={() => roomAction("stop")}
              >
                Adedonha!
              </button>
            )}
            {isHost && room.status === "playing" && (
              <button
                className="save-button"
                type="button"
                disabled={
                  busy ||
                  autofilling ||
                  secondsLeft <= 0 ||
                  room.categories.every((category) => answers[category]?.trim())
                }
                onClick={autofillAnswers}
              >
                {autofilling ? "Preenchendo..." : "Autopreencher respostas"}
              </button>
            )}
            {isHost &&
              (room.status === "lobby" || room.status === "review") && (
                <button
                  className="plain-button"
                  disabled={busy}
                  onClick={chooseNextLetter}
                >
                  Nova letra
                </button>
              )}
            <button
              className="plain-button"
              disabled={busy}
              onClick={leaveRoom}
            >
              Sair da sala
            </button>
            <span className="status-muted">
              {room.status === "lobby"
                ? "esperando o anfitrião"
                : room.status === "playing"
                  ? "valendo"
                  : room.status === "closing"
                    ? "corrigindo respostas..."
                    : "resultado automático"}
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {room.categories.map((category) => {
              const answer = answers[category] || "";
              const correct =
                answer.trim().charAt(0).toUpperCase() === room.letter;
              return (
                <article className="answer-card" key={category}>
                  <label className="block">
                    <span className="block text-sm font-extrabold">
                      {category}
                    </span>
                    <input
                      className="answer-input"
                      maxLength={MAX_ANSWER_LENGTH}
                      disabled={room.status !== "playing" || secondsLeft <= 0}
                      onBlur={() => flushAnswer(category)}
                      onChange={(event) =>
                        saveAnswer(category, event.target.value)
                      }
                      placeholder={`Resposta com ${room.letter}`}
                      value={answer}
                    />
                  </label>
                  <div className="mt-3">
                    <span
                      className={
                        answer
                          ? correct
                            ? "status-good"
                            : "status-warn"
                          : "status-muted"
                      }
                    >
                      {room.status === "review"
                        ? "resultado abaixo"
                        : room.status === "closing"
                          ? "aguardando correção"
                          : answer
                            ? correct
                              ? "começa certo"
                              : "confere a letra"
                            : "em branco"}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
          {room.status === "review" && (
            <>
              <section className="result-section">
                <h2>{isHost ? "Correção da turma" : "Minha correção"}</h2>
                <div className="mt-4 grid gap-3">
                  {reviewAnswers.map((answer) => {
                    const answerKey = `${answer.playerId}-${answer.category}`;
                    return (
                      <article className="history-item" key={answerKey}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong>
                            {isHost
                              ? `${answer.playerName} · ${answer.category}`
                              : answer.category}
                          </strong>
                          <span
                            className={validationClass(answer.validationStatus)}
                          >
                            {answer.score} pts ·{" "}
                            {validationLabel(answer.validationStatus)}
                          </span>
                        </div>
                        <p className="mt-2 text-lg font-bold">
                          {answer.value || "Em branco"}
                        </p>
                        {answer.validationReason && (
                          <p className="mt-2 text-sm text-[#70685d]">
                            {answer.validationReason}
                          </p>
                        )}
                        {isHost && (
                          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[#e5dbc8] pt-3">
                            <span className="text-xs font-extrabold text-[#70685d]">
                              Ajuste
                            </span>
                            <div
                              className="segmented"
                              role="group"
                              aria-label={`Ajustar pontos de ${answer.playerName} em ${answer.category}`}
                            >
                              {[0, 5, 10].map((score) => (
                                <button
                                  className={
                                    answer.score === score ? "active" : ""
                                  }
                                  disabled={Boolean(adjustingAnswer)}
                                  key={score}
                                  onClick={() => adjustScore(answer, score)}
                                  type="button"
                                  aria-pressed={answer.score === score}
                                >
                                  {score}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
              <section className="result-section">
                <h2>Pódio</h2>
                <ol className="mt-3 space-y-2">
                  {room.podium.map((player, index) => (
                    <li
                      className="history-item flex items-center justify-between"
                      key={player.id}
                    >
                      <span>
                        <strong>{index + 1}.</strong> {player.name}
                      </span>
                      <strong>{player.score} pts</strong>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
          {message && (
            <p aria-live="polite" className="text-sm font-bold text-[#9b2226]">
              {message}
            </p>
          )}
        </div>
        <aside className="space-y-4">
          <section className="side-panel">
            <h2>Jogadores</h2>
            <div className="mt-3 space-y-2">
              {room.players.map((player) => (
                <div
                  className="history-item flex items-center justify-between"
                  key={player.id}
                >
                  <span>{player.name}</span>
                  {player.id === room.hostId && (
                    <span className="status-good">anfitrião</span>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="side-panel">
            <h2>Convide a turma</h2>
            <p className="mt-2 text-sm text-[#70685d]">Passe este código:</p>
            <p className="mt-1 text-3xl font-black text-[#005f73]">
              {room.code}
            </p>
            <button
              className="plain-button mt-3 w-full"
              type="button"
              onClick={copyRoomCode}
            >
              Copiar código
            </button>
          </section>
        </aside>
      </section>
    </main>
  );
}
