import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Control Room Router A/B mode E2E tests.
 *
 * The repo ships a single happy-path spec under `e2e/router-ab.spec.ts`.
 * The spec exercises the full user flow: open the chat, send a prompt,
 * observe Side A stream, observe Side B resolve, click feedback, reload
 * to re-hydrate. Everything else (router output validation, budget
 * guard, disallowed rejection, etc.) is covered by `lib/router/*.test.ts`
 * unit tests.
 *
 * We spawn `next start` on a random port for stability. The build is
 * produced by `npm run build` once before tests run; the test script
 * does NOT rebuild — that is the caller's responsibility (the README
 * and the docs/runbook explain it).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      'bash -lc "set -a; . /etc/hermes/control_room_postgres.env; set +a; PORT=3100 HOSTNAME=127.0.0.1 CONTROL_ROOM_FAKE_LLM=1 CONTROL_ROOM_FAKE_OPENAI_MODELS=1 npm run start -- -p 3100 -H 127.0.0.1"',
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
    },
  },
});
