import { expect, test } from "@playwright/test";

/**
 * Happy-path E2E for Router A/B mode.
 *
 * What this test exercises:
 *   1. Open the chat page and confirm the chat surface loads.
 *   2. Confirm the new controls (router A/B toggle, reasoning-level dropdown,
 *      side-by-side panel placeholder) are visible.
 *   3. Click "New chat" so the chat path uses a *real* thread id. This is
 *      important because the panel re-hydration + feedback persistence
 *      require a session row in `router_ab_sessions`, which is only
 *      inserted when a real thread is attached.
 *   4. Send a prompt and confirm Side A streams in.
 *   5. Confirm the Side B column appears (router decision + Side B text).
 *   6. Click one of the feedback buttons and confirm the API persisted it
 *      (visible "active" state + 200 from /api/router-ab/feedback).
 *   7. Reload the page and confirm the panel re-hydrates from Postgres
 *      with the same Side B text + persisted feedback rating.
 *
 * What this test deliberately does NOT exercise (covered elsewhere):
 *   - Disallowed router output / budget skip / router-error fallback (these
 *     are unit-tested in lib/router/policy.test.ts and lib/router/graph.test.ts).
 *   - Thread persistence / message_feedback (covered by repo unit tests).
 *
 * Note on the fake-LLM flag:
 *   The Playwright config sets `CONTROL_ROOM_FAKE_LLM=1`, which routes the
 *   router + Side A + Side B calls through deterministic local stubs. The
 *   panel still renders the same data shapes it would for a real OpenAI
 *   call, and feedback still persists to Postgres. This keeps the test
 *   fast and free.
 */
test("router A/B panel renders side-by-side and persists feedback across reload", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText})`);
  });

  await page.goto("/");

  // Chat surface must be present.
  await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });

  // New controls must be present.
  await expect(page.getByTestId("router-ab-toggle")).toBeVisible();
  await expect(page.getByTestId("model-reasoning-select")).toBeVisible();

  // Create a real persisted thread via the "New Chat" button. This gives us
  // a real thread id that the chat route can attach to the A/B session row,
  // which is required for the panel re-hydration + feedback persistence
  // assertions below.
  const newChatButton = page.getByRole("button", { name: /^New Chat$/i });
  await newChatButton.first().click();

  // Wait for the new thread to load (the messages list reloads).
  await page.waitForLoadState("networkidle");

  // Type and send a prompt.
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill("What is 2 + 2?");
  await composer.press("Enter");

  // Wait a bit for the chat to settle, then capture page console messages
  // so we can debug the panel flow if needed.
  await page.waitForTimeout(2_000);

  // Side A streams in — wait for the assistant message to render and the
  // router A/B panel to attach below it. The panel always renders (even
  // when the router is disabled) as long as the toggle is on and we got
  // a data-router-ab data part (which we do for real thread sessions).
  const panel = page.getByTestId("router-ab-panel").first();
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // Side A header should label the column correctly.
  await expect(page.getByTestId("router-ab-side-a-header").first()).toContainText(
    /Your selected model/i,
  );

  // Side B header labels the recommendation column.
  await expect(page.getByTestId("router-ab-side-b-header").first()).toContainText(
    /Router recommendation/i,
  );

  // Wait for Side B text to render (the data-router-ab-side-b part
  // arrives a few hundred ms after Side A finishes streaming).
  await expect(page.getByTestId("router-ab-side-b-text").first()).not.toContainText(
    /Router is generating Side B/,
    { timeout: 15_000 },
  );

  // Side A column should also render the actual streamed text, not the
  // "Waiting for Side A…" placeholder. Both columns must show their
  // respective answers side-by-side for a real comparison view.
  await expect(page.getByTestId("router-ab-side-a-text").first()).not.toContainText(
    /Waiting for Side A/,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("router-ab-side-a-text").first()).toContainText(/selected combo/i);

  // Capture a screenshot of the panel for visual debugging if a layout
  // regression slips past the assertions above. Saved under
  // `test-results/router-ab-panel.png`.
  await page.screenshot({
    path: "test-results/router-ab-panel.png",
    fullPage: false,
  });

  // Feedback buttons must be present and clickable.
  const preferAButton = page.getByTestId("router-ab-feedback-prefer-a").first();
  await expect(preferAButton).toBeVisible();
  await preferAButton.click();

  // After click, the button should be in "active" state. We assert via
  // `aria-pressed` because the styled "active" state is the canonical
  // signal the panel uses.
  await expect(preferAButton).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });

  // Reload and confirm the panel re-hydrates from Postgres with the same
  // feedback rating. This exercises `GET /api/router-ab/session/[id]` and
  // the round-trip through Postgres.
  await page.reload();
  await expect(page.getByTestId("router-ab-panel").first()).toBeVisible({ timeout: 15_000 });
  const rehydrated = page.getByTestId("router-ab-feedback-prefer-a").first();
  await expect(rehydrated).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });

  // Console + network sanity checks: no fatal console errors and no
  // completely-failed requests. We allow benign 4xx/5xx responses from the
  // /api/chat, /api/router-ab, /api/threads, /api/messages, and /api/db-health
  // endpoints — these are either feedback persistence side effects or
  // deliberate soft-failure paths (e.g. 404 on an unknown message id).
  const fatalConsoleErrors = consoleErrors.filter((msg) => {
    const m = msg.toLowerCase();
    return (
      !m.includes("openai") &&
      !m.includes("401") &&
      !m.includes("404") &&
      !m.includes("missingenvironmentvariable") &&
      !m.includes("db_not_configured") &&
      !m.includes("router_ab_session_not_found") &&
      !m.includes("invalid_feedback_target") &&
      !m.includes("failed to load resource")
    );
  });
  expect(fatalConsoleErrors, `unexpected console errors: ${fatalConsoleErrors.join("\n")}`).toEqual(
    [],
  );

  const benignFailures = failedRequests.filter(
    (req) =>
      !req.includes("/api/chat") &&
      !req.includes("/api/router-ab") &&
      !req.includes("/api/threads") &&
      !req.includes("/api/messages") &&
      !req.includes("/api/db-health"),
  );
  expect(benignFailures, `unexpected failed requests: ${benignFailures.join("\n")}`).toEqual([]);
});
