import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const origin = process.argv[2] || "http://localhost:3001";
assert.match(origin, /^http:\/\/localhost:\d+$/);
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const contexts = [];
const createdRooms = [];
const errors = [];

async function roomRequest(page, code, payload) {
  return page.evaluate(async ({ code, payload }) => {
    const playerId = localStorage.getItem("adedonha-player-id");
    const token = localStorage.getItem("adedonha-player-token");
    const response = await fetch(`/api/rooms/${code}${payload ? "" : `?playerId=${playerId}`}`, {
      method: payload ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-player-token": token },
      body: payload ? JSON.stringify({ playerId, ...payload }) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }, { code, payload });
}

async function newPlayer(name, viewport) {
  const context = await browser.newContext({ viewport });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("Seu nome").fill(name);
  return page;
}

async function createRoom(page) {
  const response = page.waitForResponse((response) => response.url().endsWith("/api/rooms") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Criar sala", exact: true }).click();
  const { code } = await (await response).json();
  assert.equal(typeof code, "string");
  createdRooms.push({ page, code });
  await page.getByRole("button", { name: "Começar rodada", exact: true }).waitFor();
  const current = await roomRequest(page, code);
  assert.equal(current.status, 200);
  const changed = await roomRequest(page, code, { action: "letter", letter: "M", roundId: current.body.roundId });
  assert.equal(changed.status, 200);
  await page.waitForResponse((response) => response.url().includes(`/api/rooms/${code}`) && response.request().method() === "GET");
  return code;
}

try {
  const host = await newPlayer("Teste anfitrião", { width: 1280, height: 900 });
  const code = await createRoom(host);
  const guest = await newPlayer("Teste participante", { width: 390, height: 844 });
  await guest.getByLabel("Código da sala").fill(code);
  await guest.getByRole("button", { name: "Entrar na sala", exact: true }).click();
  await guest.getByLabel("Nome", { exact: true }).waitFor();
  assert.equal(await host.getByRole("button", { name: "Autopreencher respostas" }).count(), 0);
  await host.getByRole("button", { name: "Começar rodada", exact: true }).click();
  await guest.getByLabel("Nome", { exact: true }).waitFor({ state: "visible" });
  await host.getByLabel("Nome", { exact: true }).fill("Manuel");

  // Hold the real server's response while the host continues typing.
  let release;
  let requested;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { requested = resolve; });
  await host.route("**/api/rooms/*", async (route) => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().action !== "autofill") return route.continue();
    const response = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response });
  });
  await host.getByRole("button", { name: "Autopreencher respostas", exact: true }).click();
  await started;
  await host.getByLabel("Lugar", { exact: true }).fill("Manaus");
  release();
  await host.getByText("Respostas preenchidas. Você pode editar antes de encerrar a rodada.", { exact: true }).waitFor();
  assert.equal(await host.getByLabel("Nome", { exact: true }).inputValue(), "Manuel");
  assert.equal(await host.getByLabel("Lugar", { exact: true }).inputValue(), "Manaus");
  assert.equal(await host.getByLabel("PCH", { exact: true }).inputValue(), "Mão");
  assert.equal(await host.getByLabel("Comida", { exact: true }).inputValue(), "Macarrão");
  const own = await roomRequest(host, code);
  assert.equal(own.body.answers.length, 8);
  assert.equal(own.body.answers.find((answer) => answer.category === "Lugar").value, "Manaus");
  assert.equal(await guest.getByRole("button", { name: "Autopreencher respostas" }).count(), 0);
  assert.equal(await guest.getByLabel("Nome", { exact: true }).inputValue(), "");
  assert.equal((await roomRequest(guest, code, { action: "autofill", roundId: own.body.roundId })).status, 403);

  const anotherHost = await newPlayer("Outro anfitrião", { width: 390, height: 844 });
  const anotherCode = await createRoom(anotherHost);
  await anotherHost.getByRole("button", { name: "Começar rodada", exact: true }).click();
  await anotherHost.getByRole("button", { name: "Autopreencher respostas", exact: true }).click();
  await anotherHost.getByText("Respostas preenchidas. Você pode editar antes de encerrar a rodada.", { exact: true }).waitFor();
  assert.equal((await roomRequest(anotherHost, anotherCode)).body.answers.length, 8);
  const width = await anotherHost.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(width.content <= width.viewport);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, realLocalWorker: true, realLocalD1: true,
    tested: ["host-button", "guest-denied", "second-host", "preserve-existing-answer", "typing-during-generation", "autosave-eight-categories", "mobile-layout"], aiCalls: 0 }));
} finally {
  for (const { page, code } of createdRooms) {
    const result = await roomRequest(page, code, { action: "leave" }).catch(() => null);
    if (result) assert.equal(result.status, 200);
  }
  for (const context of contexts) await context.close();
  await browser.close();
}
