// A9 screenshot capture for visual review. This script starts nothing itself.
// Run it against a dev server that you started with a scratch DB and the fixture
// LLM, for example:
//
//   USE_FIXTURE_LLM=1 DATABASE_PATH=./data/ui-shots.db APP_PASSWORD=test-password \
//     SESSION_SECRET=ui-shots-secret-0000000000000000 \
//     ANTHROPIC_API_KEY=sk-ant-fixture npm run dev -- --port 3100
//
// then, in another shell:  npm run ui-shots
//
// It logs in with Playwright, seeds minimal demo data via the API (a fact, a
// character with a state, a chapter with a short draft), and captures BOTH themes
// of the main pages into ./ui-shots/<theme>-<page>.png.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.UI_SHOTS_BASE ?? "http://localhost:3100";
const PASSWORD = process.env.UI_SHOTS_PASSWORD ?? "test-password";
const OUT = "ui-shots";

mkdirSync(OUT, { recursive: true });

async function login(page) {
  const deadline = Date.now() + 60_000;
  await page.goto(`${BASE}/login`);
  for (;;) {
    await page.getByLabel("Password").fill(PASSWORD);
    const wait = page
      .waitForResponse((r) => r.url().includes("/api/auth/login"), { timeout: 8_000 })
      .catch(() => null);
    await page.getByRole("button", { name: "Enter" }).click();
    const resp = await wait;
    if (resp && resp.ok()) break;
    if (Date.now() > deadline) throw new Error("login never succeeded");
    await page.goto(`${BASE}/login`);
  }
  await page.waitForURL(/\/canon/, { timeout: 30_000 });
}

async function seed(request) {
  await request.post(`${BASE}/api/canon`, {
    data: {
      type: "world_rule",
      content: "The tower drinks light from anyone who climbs it.",
      status: "locked",
    },
  });
  const charRes = await request.post(`${BASE}/api/characters`, {
    data: {
      name: "Mara",
      role: "reluctant climber",
      voiceRules: "dry, understated, never says the thing directly",
      physical: "tall, wind-burned, a burn scar along one wrist",
      notes: "keeps a half-burned letter she will not read",
    },
  });
  const characterId = (await charRes.json()).character.id;
  await request.post(`${BASE}/api/characters/${characterId}/states`, {
    data: {
      projectId: 1,
      chapterOrder: 0,
      knows: "the fire was set on purpose",
      feels: "wary of everyone who was there that night",
      hiding: "that she is an elemental, from everyone",
    },
  });
  const chapRes = await request.post(`${BASE}/api/chapters`, {
    data: {
      projectId: 1,
      title: "The Open Gate",
      pov: "Mara",
      synopsis: "Mara reaches the tower gate and feels the light pull at her.",
      beats: ["She reaches the gate", "The wind rises and the light leans in"],
    },
  });
  const chapterId = (await chapRes.json()).chapter.id;
  await request.post(`${BASE}/api/chapters/${chapterId}/save-draft`, {
    data: {
      content:
        "The gate stood open, and the wind came through it like a spoken name. " +
        "Mara set her hand to the cold iron and felt the tower lean toward her, " +
        "patient as a creditor. She did not look up. Looking up was how it started, " +
        "her mother had said, once, before the fire.",
    },
  });
  return { characterId, chapterId };
}

async function shoot(page, theme, name, url, prep) {
  // Set the theme cookie for this context, then load the page fresh so the server
  // stamps the class at render.
  await page.context().addCookies([
    { name: "bookforge_theme", value: theme, url: BASE },
  ]);
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  if (prep) await prep(page);
  await page.screenshot({ path: `${OUT}/${theme}-${name}.png`, fullPage: true });
  console.log(`captured ${theme}-${name}.png`);
}

async function pinChat(page) {
  await page.getByTestId("set-pin-button").click();
  await page.getByTestId("chat-pin").waitFor({ timeout: 10_000 });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

// Login page shots first, in a themed but logged-out context.
for (const theme of ["light", "dark"]) {
  await shoot(page, theme, "login", "/login");
}

await login(page);
const { characterId, chapterId } = await seed(page.request);

const pages = [
  ["home", "/"],
  ["canon", "/canon"],
  ["characters", "/characters"],
  ["chat", `/characters/${characterId}/chat`, pinChat],
  ["sequencer", "/book/1"],
  ["draft", `/book/1/chapter/${chapterId}/draft`],
  ["review", `/book/1/chapter/${chapterId}/review`],
  ["settings", "/settings"],
];

for (const theme of ["light", "dark"]) {
  for (const [name, url, prep] of pages) {
    await shoot(page, theme, name, url, prep);
  }
}

await browser.close();
console.log("done");
