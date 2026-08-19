// One-shot browser reproduction for the Recommend ON accept/send chain.
// Captures browser console messages tagged [recommend-send-proof] and
// every network request to /api/chat (or other chat endpoints) so we
// can see exactly where the chain stops.
//
// Usage: node scripts/recommend-send-proof.mjs [baseURL]
// Default baseURL: http://127.0.0.1:18100 (live prod)
import { chromium } from "@playwright/test";

const baseURL = process.argv[2] || "http://127.0.0.1:18100";
const TEST_PROMPT = "Recommend ON proof " + Date.now();

const consoleLines = [];
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
  consoleLines.push({ ts: ts(), type: msg.type(), text });
  if (text.includes("[recommend-send-proof]")) {
    console.log(`[BROWSER ${msg.type().toUpperCase()}] ${text}`);
  }
});
page.on("pageerror", (err) => {
  console.log(`[BROWSER PAGEERROR] ${err.message}`);
  consoleLines.push({ ts: ts(), type: "pageerror", text: err.message });
});
page.on("request", (req) => {
  const url = req.url();
  if (
    url.includes("/api/chat") ||
    url.includes("/api/model/recommend") ||
    url.includes("/api/router/decision") ||
    url.includes("/api/threads")
  ) {
    let bodySummary = "";
    let fullBody = "";
    try {
      const data = req.postData();
      if (data) {
        fullBody = data;
        bodySummary = data.length > 1200 ? data.slice(0, 1200) + "..." : data;
      }
    } catch {}
    chatRequests.push({ ts: ts(), method: req.method(), url, bodySummary, fullBody });
    console.log(`[NET ${req.method()}] ${url}`);
    if (bodySummary) console.log(`  body: ${bodySummary}`);
  }
});
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("/api/chat") || url.includes("/api/model/recommend")) {
    chatResponses.push({ ts: ts(), status: res.status(), url });
    console.log(`[NET RESP ${res.status()}] ${url}`);
  }
});

try {
  logSection("STEP 0: navigate to chat");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Best-effort: wait for composer to be visible.
  // ComposerPrimitive.Input renders as a <textarea> with aria-label
  // "Message input (press C to focus)".
  const composerInput = page.locator('textarea[aria-label*="Message input"]').first();
  await composerInput.waitFor({ state: "visible", timeout: 30_000 });
  console.log("composer visible");

  logSection("STEP 1: ensure Recommend ON");
  // The Recommend toggle is a Switch; the underlying <input> has the
  // data-testid "recommender-toggle" (from earlier chat-surface UI).
  // If it's not directly findable, we set sessionStorage before reload.
  const recommendChecked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="recommender-toggle"]');
    if (el && "checked" in el) return Boolean(el.checked);
    return null;
  });
  console.log(`recommender-toggle initial checked = ${recommendChecked}`);
  if (recommendChecked !== true) {
    await page.evaluate(() => {
      try {
        window.sessionStorage.setItem("control_room.recommender_enabled", "true");
      } catch {}
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('textarea[aria-label*="Message input"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const recheck = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="recommender-toggle"]');
      return el && "checked" in el ? Boolean(el.checked) : null;
    });
    console.log(`recommender-toggle after reload checked = ${recheck}`);
  }

  logSection("STEP 2: type prompt");
  const composer = page.locator('textarea[aria-label*="Message input"]').first();
  await composer.click();
  await composer.fill(TEST_PROMPT);
  console.log(`typed prompt: "${TEST_PROMPT}"`);

  logSection("STEP 3: click Send (recommend intercept expected)");
  // The Send button has class .aui-composer-send and is the small
  // arrow-up button in the composer. Click it.
  const sendBtn = page.locator(".aui-composer-send").first();
  await sendBtn.click();
  console.log("Send clicked");

  // Wait for the recommendation banner to appear OR an error.
  // The banner contains an Accept button; it's a button with text
  // starting with "Use".
  logSection("STEP 4: wait for recommendation banner (max 20s)");
  let acceptBtn = null;
  for (let i = 0; i < 40; i++) {
    acceptBtn = page
      .locator("button")
      .filter({ hasText: /Use recommended|Use recommendation|Accept/i })
      .first();
    if (await acceptBtn.count()) {
      const visible = await acceptBtn.isVisible().catch(() => false);
      if (visible) break;
    }
    await page.waitForTimeout(500);
  }
  if (!(await acceptBtn.count())) {
    console.log("WARN: no Accept button found after 20s");
  } else {
    logSection("STEP 5: click Accept");
    console.log("clicking Accept");
    await acceptBtn.click();
    console.log("Accept clicked");
  }

  // Wait long enough to capture the post-accept send chain (transport
  // assembly + /api/chat). Anything beyond ~8s means the request
  // didn't fire.
  logSection("STEP 6: wait 8s for send chain to fire");
  await page.waitForTimeout(8000);

  logSection("SUMMARY");
  const proofLines = consoleLines.filter((l) => l.text.includes("[recommend-send-proof]"));
  console.log(`total console lines captured: ${consoleLines.length}`);
  console.log(`[recommend-send-proof] lines: ${proofLines.length}`);
  console.log(`/api/chat-like requests seen: ${chatRequests.length}`);
  console.log(`/api/chat-like responses seen: ${chatResponses.length}`);

  // Print the proof-tagged console lines in order so we can read the chain.
  console.log("\n--- [recommend-send-proof] console lines in order ---");
  for (const l of proofLines) {
    console.log(`[${l.ts}] [${l.type}] ${l.text}`);
  }

  console.log("\n--- /api/chat-like requests ---");
  for (const r of chatRequests) {
    console.log(`[${r.ts}] ${r.method} ${r.url}`);
    if (r.bodySummary) console.log(`    body: ${r.bodySummary}`);
  }
  console.log("\n--- /api/chat-like responses ---");
  for (const r of chatResponses) {
    console.log(`[${r.ts}] ${r.status} ${r.url}`);
  }

  // Step-by-step verdict
  console.log("\n--- chain verdict ---");
  const has = (substr) => proofLines.some((l) => l.text.includes(substr));
  console.log(`handleUseRecommendation:entry                ${has("handleUseRecommendation:entry")}`);
  console.log(`handleUseRecommendation:targets              ${has("handleUseRecommendation:targets")}`);
  console.log(`handleUseRecommendation:setPendingRoutingDec ${has("handleUseRecommendation:setPendingRoutingDecision")}`);
  console.log(`handleUseRecommendation:setPendingRecommendedSend ${has("handleUseRecommendation:setPendingRecommendedSend")}`);
  console.log(`ComposerAction:useEffect:entry               ${has("ComposerAction:useEffect:entry")}`);
  console.log(`ComposerAction:setText:calling               ${has("ComposerAction:setText:calling")}`);
  console.log(`ComposerAction:send:calling                  ${has("ComposerAction:send:calling")}`);
  console.log(`ComposerAction:send:returned                 ${has("ComposerAction:send:returned")}`);
  console.log(`onPendingRecommendedSendConsumed:called      ${has("onPendingRecommendedSendConsumed:called")}`);
  console.log(`transport:prepareSendMessagesRequest         ${has("transport:prepareSendMessagesRequest")}`);
  console.log(`/api/chat:POST:entry                         ${has("/api/chat:POST:entry")}`);
  console.log(`/api/chat:POST:body                          ${has("/api/chat:POST:body")}`);

  // Parse /api/chat requests and check routingDecision
  console.log("\n--- routingDecision assertions ---");
  let hasChatApiCall = false;
  let hasNonNullRoutingDecision = false;
  let hasRoutingDecisionAuditId = false;
  let hasModelRecommend = false;
  let hasRouterDecision = false;

  for (const r of chatRequests) {
    if (r.url.includes("/api/model/recommend")) {
      hasModelRecommend = true;
    }
    if (r.url.includes("/api/router/decision")) {
      hasRouterDecision = true;
    }
    if (r.url.includes("/api/chat") && r.method === "POST") {
      hasChatApiCall = true;
      try {
        // Try fullBody first, then fall back to bodySummary
        const bodyToParse = r.fullBody || r.bodySummary;
        const data = JSON.parse(bodyToParse);
        if (data.routingDecision !== null && data.routingDecision !== undefined) {
          hasNonNullRoutingDecision = true;
          if (data.routingDecision?.auditId) {
            hasRoutingDecisionAuditId = true;
            console.log(`✓ /api/chat received non-null routingDecision`);
            console.log(`  auditId: ${data.routingDecision.auditId}`);
            console.log(`  executionModel: ${data.routingDecision.executionModel}`);
            console.log(`  selectionSource: ${data.routingDecision.selectionSource}`);
          } else {
            console.log(`✗ routingDecision present but auditId is null/undefined`);
            console.log(`  routingDecision: ${JSON.stringify(data.routingDecision)}`);
          }
        } else {
          console.log(`✗ /api/chat received null/undefined routingDecision`);
          console.log(`  Full body snippet: ${bodyToParse.substring(0, 500)}...`);
        }
      } catch (e) {
        // If JSON parsing fails, check if "routingDecision" appears in the body text
        const bodyToCheck = r.fullBody || r.bodySummary;
        if (bodyToCheck.includes('"routingDecision":null') || bodyToCheck.includes('"routingDecision": null')) {
          console.log(`✗ /api/chat body contains "routingDecision": null (explicit null)`);
        } else if (bodyToCheck.includes('"routingDecision"')) {
          console.log(`? /api/chat body contains routingDecision but could not parse JSON: ${e.message}`);
          // Try to extract routingDecision value
          const match = bodyToCheck.match(/"routingDecision":\s*(\{[^}]+\}|null)/);
          if (match) {
            console.log(`  Found routingDecision value: ${match[1]}`);
            if (match[1] !== 'null' && match[1] !== null) {
              hasNonNullRoutingDecision = true;
            }
          }
        } else {
          console.log(`✗ /api/chat body does not contain routingDecision field`);
          console.log(`  Body snippet: ${bodyToCheck.substring(0, 300)}...`);
        }
      }
    }
  }

  console.log("\n--- assertions summary ---");
  console.log(`1. /api/model/recommend is called:           ${hasModelRecommend ? "PASS" : "FAIL"}`);
  console.log(`2. /api/chat is called:                     ${hasChatApiCall ? "PASS" : "FAIL"}`);
  console.log(`3. /api/chat has non-null routingDecision:  ${hasNonNullRoutingDecision ? "PASS" : "FAIL"}`);
  console.log(`4. routingDecision has non-null auditId:    ${hasRoutingDecisionAuditId ? "PASS" : "FAIL"}`);
  console.log(`5. /api/router/decision NOT called:         ${!hasRouterDecision ? "PASS" : "FAIL"}`);

  const allPassed = hasModelRecommend && hasChatApiCall && hasNonNullRoutingDecision && hasRoutingDecisionAuditId && !hasRouterDecision;
  console.log(`\n=== OVERALL: ${allPassed ? "ALL ASSERTIONS PASSED" : "SOME ASSERTIONS FAILED"} ===`);

  if (!allPassed) {
    process.exitCode = 1;
  }
} catch (err) {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  console.log("\n--- captured console lines so far ---");
  for (const l of consoleLines.filter((x) => x.text.includes("[recommend-send-proof]"))) {
    console.log(`[${l.ts}] [${l.type}] ${l.text}`);
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}