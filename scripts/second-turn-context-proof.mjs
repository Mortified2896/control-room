// One-shot live reproduction for the second-turn context-exclusion
// proof. Sends "Hi" as turn 1, then sends a second prompt and
// inspects the /api/chat request body to prove the FIRST turn's
// routing decision is NOT in the model context for turn 2.
//
// Hard rules:
//   - Recommend OFF (manual selection path), no /api/router/decision
//     call. No OpenAI API billing.
//   - No full E2E: this is a single script, not the playwright
//     suite. Other specs are untouched.
//   - No commit/push: this file is local-only.

import { chromium } from "@playwright/test";

const baseURL = process.argv[2] || "http://127.0.0.1:18100";
const FIRST_PROMPT = "Hi";
const SECOND_PROMPT = "What did I just say first?";

const chatRequests = [];

function ts() {
  return new Date().toISOString();
}

function logSection(title) {
  console.log("\n" + "=".repeat(72));
  console.log(`[${ts()}] ${title}`);
  console.log("=".repeat(72));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL });
const page = await context.newPage();

page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/api/chat") || url.includes("/api/router/decision")) {
    let bodySummary = "";
    try {
      const data = req.postData();
      if (data) bodySummary = data;
    } catch {}
    chatRequests.push({ ts: ts(), method: req.method(), url, body: bodySummary });
    console.log(`[NET ${req.method()}] ${url}`);
  }
});

try {
  logSection("STEP 0: navigate + force Recommend OFF");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator('textarea[aria-label*="Message input"]').first().waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => {
    try {
      window.sessionStorage.setItem("control_room.recommender_enabled", "false");
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('textarea[aria-label*="Message input"]').first().waitFor({ state: "visible", timeout: 30_000 });

  logSection("STEP 1: new chat, send first prompt");
  const newChatButton = page.getByRole("button", { name: /^New Chat$/i });
  await newChatButton.first().click();
  await page.waitForLoadState("networkidle");
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill(FIRST_PROMPT);
  await composer.press("Enter");
  await page.waitForTimeout(8000);

  logSection("STEP 2: send second prompt");
  chatRequests.length = 0; // clear requests from turn 1
  await composer.fill(SECOND_PROMPT);
  await composer.press("Enter");
  await page.waitForTimeout(5000);

  logSection("STEP 3: inspect second /api/chat request body");
  const secondTurnChat = chatRequests.find((r) => r.url.includes("/api/chat"));
  if (!secondTurnChat) throw new Error("no /api/chat request captured for turn 2");
  console.log("body length:", secondTurnChat.body.length);
  console.log("body:");
  console.log(secondTurnChat.body);

  const body = secondTurnChat.body;

  let failures = 0;
  const require = (cond, label) => {
    if (cond) console.log(`  PASS  ${label}`);
    else {
      console.log(`  FAIL  ${label}`);
      failures += 1;
    }
  };

  // The body must carry turn 1's user prompt and turn 1's model reply,
  // and turn 2's user prompt. It must NOT carry the routing decision
  // audit bubble (route, recommender engine, alternatives, etc.).
  require(body.includes(FIRST_PROMPT), `body contains first user prompt ("${FIRST_PROMPT}")`);
  require(
    body.includes("Hi there") || body.includes("model") || body.includes("help"),
    "body contains first turn's assistant reply text (some substring)",
  );
  require(body.includes(SECOND_PROMPT), `body contains second user prompt ("${SECOND_PROMPT}")`);
  require(!body.includes("Routing decision"), "body does NOT contain the routing-decision audit header");
  require(
    !body.includes("Saved for visibility only"),
    "body does NOT contain the audit-bubble visibility footer",
  );
  require(
    !body.includes("audit-e2e") &&
      !body.includes("audit-") &&
      !body.includes("Recommendations returned".toLowerCase()),
    "body does NOT contain the routing decision audit id or alternatives section",
  );
  require(
    !body.includes("manual_current_selection") && !body.includes("Selection source"),
    "body does NOT contain routing decision selection source",
  );
  require(
    !body.includes("Recommendations returned") &&
      !body.includes("Alternatives returned"),
    "body does NOT contain alternatives JSON",
  );

  // No /api/router/decision call must have been made.
  const routerDecisionCalls = chatRequests.filter((r) =>
    r.url.includes("/api/router/decision"),
  );
  require(routerDecisionCalls.length === 0, "no /api/router/decision call");

  if (failures > 0) {
    console.log(`\n[FAIL] ${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\n[OK] second-turn model context excludes first turn's routing decision");
  }
} catch (err) {
  console.error("[FATAL]", err);
  process.exit(2);
} finally {
  await browser.close();
}
