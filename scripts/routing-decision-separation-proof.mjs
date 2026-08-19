// One-shot live reproduction for the routing decision separation fix.
//
// This is NOT a Playwright test suite. It is a manual-verification
// harness that drives the live production site, sends a single
// "Hi" prompt with Recommend OFF (the exact path the user
// reported as broken), and prints the visible DOM order of the
// user / routing-decision / model-response bubbles. The script
// exits non-zero if the visible order is wrong, so the operator
// can re-run it after restart and see at a glance whether the
// fix is live.
//
// Run after `scripts/restart-prod.sh`:
//   node scripts/routing-decision-separation-proof.mjs
//
// Hard rules followed by this script:
//   - No OpenAI API billing: Recommend is OFF, so the manual
//     selection runs through the existing Codex (ChatGPT
//     subscription) path, never through OpenAI API billing.
//   - No `/api/router/decision` call: the Recommend-OFF path
//     uses the manual current selection, not the recommender
//     engine. The script asserts no `/api/router/decision` is
//     hit during the run.
//   - No full E2E: this is one script, not the playwright
//     suite. Other specs are untouched.
//   - No commit/push: this file is local-only.

import { chromium } from "@playwright/test";

const baseURL = process.argv[2] || "http://127.0.0.1:18100";
const TEST_PROMPT = "Hi";

const chatRequests = [];
const chatResponses = [];

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

page.on("console", (msg) => {
  const text = msg.text();
  // surface routing-decision-related console logs only
  if (text.includes("routing") || text.includes("Routing") || text.includes("[composer]")) {
    console.log(`[BROWSER ${msg.type().toUpperCase()}] ${text}`);
  }
});
page.on("pageerror", (err) => {
  console.log(`[BROWSER PAGEERROR] ${err.message}`);
});
page.on("request", (req) => {
  const url = req.url();
  if (
    url.includes("/api/chat") ||
    url.includes("/api/router/decision") ||
    url.includes("/api/threads")
  ) {
    let bodySummary = "";
    try {
      const data = req.postData();
      if (data) bodySummary = data.length > 1200 ? data.slice(0, 1200) + "..." : data;
    } catch {}
    chatRequests.push({ ts: ts(), method: req.method(), url, bodySummary });
    console.log(`[NET ${req.method()}] ${url}`);
    if (bodySummary) console.log(`  body: ${bodySummary}`);
  }
});
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("/api/chat") || url.includes("/api/router/decision")) {
    chatResponses.push({ ts: ts(), status: res.status(), url });
    console.log(`[NET RESP ${res.status()}] ${url}`);
  }
});

try {
  logSection("STEP 0: navigate to chat");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const composerInput = page.locator('textarea[aria-label*="Message input"]').first();
  await composerInput.waitFor({ state: "visible", timeout: 30_000 });
  console.log("composer visible");

  logSection("STEP 1: ensure Recommend OFF (manual send path)");
  // Force Recommend OFF in sessionStorage and reload so the test
  // does not depend on the toggle's current state.
  await page.evaluate(() => {
    try {
      window.sessionStorage.setItem("control_room.recommender_enabled", "false");
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('textarea[aria-label*="Message input"]').first().waitFor({ state: "visible", timeout: 30_000 });
  const recommenderOn = await page.evaluate(() => {
    return window.sessionStorage.getItem("control_room.recommender_enabled") === "true";
  });
  console.log(`recommender_enabled sessionStorage = ${recommenderOn}`);
  if (recommenderOn) throw new Error("expected Recommend OFF; got ON");

  logSection("STEP 2: start a new persisted thread");
  const newChatButton = page.getByRole("button", { name: /^New Chat$/i });
  await newChatButton.first().click();
  await page.waitForLoadState("networkidle");

  logSection(`STEP 3: type "${TEST_PROMPT}" and send (Enter)`);
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill(TEST_PROMPT);
  await composer.press("Enter");

  // Wait for the streamed model response to settle. The routing
  // decision appears as soon as `thread.runStart` fires; the
  // model response streams for up to ~30s. We poll the DOM for
  // both bubbles.
  await page.waitForTimeout(8000);

  logSection("STEP 4: read the visible bubble DOM order");
  // The chat surface uses `[data-role]` on the message root.
  // We enumerate the bubbles in the order they appear inside the
  // message group, then print a structured summary.
  const bubbles = await page.evaluate(() => {
    const roots = Array.from(
      document.querySelectorAll('[data-slot="aui_message-group"] [data-role]'),
    );
    return roots.map((root) => {
      const role = root.getAttribute("data-role");
      const heading =
        root.querySelector('h1, h2, h3, h4, h5, h6')?.textContent?.trim() ?? null;
      const testid = root.querySelector('[data-testid]')?.getAttribute("data-testid") ?? null;
      const text = (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
      return { role, heading, testid, text };
    });
  });

  console.log(`\n[VISIBLE BUBBLE COUNT] ${bubbles.length}`);
  bubbles.forEach((b, i) => {
    console.log(`\n[BUBBLE ${i}] role=${b.role}`);
    if (b.heading) console.log(`  heading: ${b.heading}`);
    if (b.testid) console.log(`  testid:  ${b.testid}`);
    console.log(`  text:    ${b.text}`);
  });

  logSection("STEP 5: assertions");
  let failures = 0;
  const require = (cond, label) => {
    if (cond) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label}`);
      failures += 1;
    }
  };

  // Must be exactly 3 bubbles: user, R, A — in that order.
  require(bubbles.length === 3, "exactly 3 visible bubbles");
  require(bubbles[0]?.role === "user", "bubble 0 is the user bubble");
  require(bubbles[0]?.text?.includes("Hi"), 'bubble 0 text contains "Hi"');
  require(bubbles[1]?.role === "assistant", "bubble 1 is an assistant bubble (R)");
  require(
    bubbles[1]?.testid === "routing-decision-bubble" ||
      bubbles[1]?.heading === "Routing decision" ||
      (bubbles[1]?.text ?? "").includes("Routing decision"),
    "bubble 1 is the routing decision audit bubble (R)",
  );
  require(
    !(bubbles[1]?.text ?? "").includes("Hi there!"),
    "bubble 1 (R) does NOT contain the model reply text",
  );
  require(bubbles[2]?.role === "assistant", "bubble 2 is an assistant bubble (A)");
  require(
    (bubbles[2]?.text ?? "").length > 0,
    "bubble 2 (A) has content (model reply is visible)",
  );
  require(
    !(bubbles[2]?.text ?? "").includes("Routing decision") ||
      (bubbles[2]?.text ?? "").includes("Hi there"),
    "bubble 2 (A) is the model reply, not the routing decision",
  );

  // No /api/router/decision call must have been made on this path.
  const routerDecisionCalls = chatRequests.filter((r) => r.url.includes("/api/router/decision"));
  require(
    routerDecisionCalls.length === 0,
    "no /api/router/decision call (Recommend OFF uses manual selection)",
  );

  // Exactly one /api/chat call (the one for the user message).
  const chatCalls = chatRequests.filter((r) => r.url.includes("/api/chat"));
  require(chatCalls.length === 1, `exactly one /api/chat call (got ${chatCalls.length})`);

  // The /api/chat request body must NOT contain the routing-decision
  // payload in messages: filterModelContextMessages strips it before
  // the request leaves the browser.
  const chatBody = chatCalls[0]?.bodySummary ?? "";
  require(
    !chatBody.includes("auditId") || !chatBody.includes("Routing decision"),
    "request body does not embed the routing-decision audit bubble text",
  );

  if (failures > 0) {
    console.log(`\n[FAIL] ${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log(`\n[OK] all assertions passed`);
  }

  logSection("STEP 6: hard refresh and re-check bubble order survives reload");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-slot="aui_message-group"]').first().waitFor({ state: "visible", timeout: 30_000 });
  const reloadBubbles = await page.evaluate(() => {
    const roots = Array.from(
      document.querySelectorAll('[data-slot="aui_message-group"] [data-role]'),
    );
    return roots.map((root) => ({
      role: root.getAttribute("data-role"),
      heading:
        root.querySelector('h1, h2, h3, h4, h5, h6')?.textContent?.trim() ?? null,
      testid: root.querySelector('[data-testid]')?.getAttribute("data-testid") ?? null,
      text: (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    }));
  });
  console.log(`\n[RELOAD VISIBLE BUBBLE COUNT] ${reloadBubbles.length}`);
  reloadBubbles.forEach((b, i) => {
    console.log(`[BUBBLE ${i}] role=${b.role} heading=${b.heading} testid=${b.testid}`);
  });
  let reloadFailures = 0;
  if (reloadBubbles.length !== 3) reloadFailures += 1;
  if (reloadBubbles[0]?.role !== "user") reloadFailures += 1;
  if (reloadBubbles[1]?.role !== "assistant") reloadFailures += 1;
  if (reloadBubbles[2]?.role !== "assistant") reloadFailures += 1;
  if (
    !(
      reloadBubbles[1]?.testid === "routing-decision-bubble" ||
      (reloadBubbles[1]?.text ?? "").includes("Routing decision")
    )
  )
    reloadFailures += 1;
  if (reloadFailures > 0) {
    console.log(`\n[FAIL] reload check failed (${reloadFailures} assertion(s))`);
    process.exit(1);
  } else {
    console.log("\n[OK] reload preserves user → R → A bubble order");
  }
} catch (err) {
  console.error("[FATAL]", err);
  process.exit(2);
} finally {
  await browser.close();
}
