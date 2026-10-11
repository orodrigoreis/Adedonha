import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const origin = process.argv[3] || "http://localhost:3001";
assert.match(origin, /^http:\/\/localhost:\d+$/);
const browser = await chromium.launch({ headless: true, channel: process.argv[4] });
const categories = ["Nome", "Lugar", "Objeto", "MSÉ", "PCH", "Palavra em Inglês", "Multimídia (filme, série, música)", "Comida"];
await mkdir(new URL("../outputs/", import.meta.url), { recursive: true });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let room;
    let leaveFails = true;
    const events = [];
    const revisions = new Map();
    // All room traffic is synthetic: the real local server renders only the UI.
    await page.route("**/api/rooms**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fulfill({ json: structuredClone(room) });
      const payload = request.postDataJSON();
      if (request.url().endsWith("/api/rooms")) {
        room = { code: "TESTE", roundId: "test-round", hostId: payload.playerId, categories, letter: "M", status: "lobby", roundEndsAt: null,
          players: [{ id: payload.playerId, name: payload.playerName }], answers: [], podium: [{ id: payload.playerId, name: payload.playerName, score: 0 }] };
        return route.fulfill({ json: { code: room.code } });
      }
      if (payload.action === "start") {
        assert.equal(payload.roundId, room.roundId);
        room.status = "playing";
        room.roundEndsAt = Date.now() + 240000;
      } else if (payload.action === "answer") {
        assert.equal(payload.roundId, room.roundId);
        if (payload.value === "Mari") await new Promise((resolve) => setTimeout(resolve, 700));
        if ((revisions.get(payload.category) || 0) < payload.answerUpdatedAt) {
          revisions.set(payload.category, payload.answerUpdatedAt);
          room.answers = room.answers.filter((answer) => answer.category !== payload.category);
          room.answers.push({ playerId: payload.playerId, playerName: room.players[0].name, category: payload.category, value: payload.value, score: 0 });
        }
        events.push(`saved:${payload.value}`);
        return route.fulfill({ json: { saved: true } });
      } else if (payload.action === "stop") {
        events.push("stop");
        room.status = "review";
        room.answers = room.answers.map((answer) => ({ ...answer, score: 10, validationStatus: "approved", validationReason: "Resposta válida" }));
        room.podium[0].score = room.answers.length * 10;
      } else if (payload.action === "leave") {
        if (leaveFails) { leaveFails = false; return route.fulfill({ status: 503, json: { error: "Tente sair novamente." } }); }
        return route.fulfill({ json: { closed: true } });
      }
      return route.fulfill({ json: structuredClone(room) });
    });
    await page.goto(origin);
    await page.getByLabel("Seu nome").fill("Teste de qualidade");
    await page.getByRole("button", { name: "Criar sala", exact: true }).click();
    await page.getByRole("button", { name: "Começar rodada" }).waitFor({ timeout: 8000 }).catch(async (error) => {
      console.log(JSON.stringify({ errors, text: await page.locator("main").innerText(), events }));
      await page.screenshot({ path: "outputs/audit-failure.png", fullPage: true });
      throw error;
    });
    assert.ok((await page.locator("main").innerText()).includes("4:00"));
    await page.getByRole("button", { name: "Começar rodada" }).click();
    await page.getByLabel("Nome", { exact: true }).fill("Mari");
    await page.waitForTimeout(250);
    await page.getByLabel("Nome", { exact: true }).fill("Marina");
    await page.getByLabel("Multimídia (filme, série, música)", { exact: true }).fill("Mamma Mia!");
    assert.equal(await page.getByLabel("Nome", { exact: true }).getAttribute("maxlength"), "80");
    await page.waitForTimeout(1000);
    assert.equal(await page.getByLabel("Nome", { exact: true }).inputValue(), "Marina");
    await page.screenshot({ path: `outputs/audit-playing-${viewport.width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Adedonha!", exact: true }).click();
    await page.getByRole("heading", { name: "Pódio" }).waitFor();
    assert.ok(events.indexOf("saved:Marina") < events.indexOf("stop"));
    assert.equal(await page.getByLabel("Nome", { exact: true }).inputValue(), "Marina");
    assert.ok((await page.locator("main").innerText()).includes("20 pts"));
    const width = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(width.content <= width.viewport, JSON.stringify(width));
    await page.screenshot({ path: `outputs/audit-review-${viewport.width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Sair da sala" }).click();
    await page.getByText("Tente sair novamente.", { exact: true }).waitFor();
    assert.ok(await page.getByRole("heading", { name: "Pódio" }).isVisible());
    await page.getByRole("button", { name: "Sair da sala" }).click();
    await page.getByRole("button", { name: "Criar sala", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, tested: ["create", "timer", "out-of-order-save", "flush-before-stop", "podium", "leave-failure", "leave-success"], pageErrors: errors.length, horizontalOverflow: false }));
    await context.close();
  }
} finally { await browser.close(); }
