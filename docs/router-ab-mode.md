# Router A/B Mode (MVP)

> Status: **MVP shipped.** Settings UI shipped at `/settings/router`
> (Postgres-backed singleton row). Env var remains as a fallback.
> Last updated 2026-06-25.

This document captures what shipped, the safety/budget controls, and what
is intentionally out of scope.

## What it does

For every prompt the user sends with the **A/B** toggle on:

1. Side A streams from the user's selected model + reasoning level
   (unchanged from the existing chat path).
2. A cheap GPT-5.4 Mini router analyzes the prompt and a short recent
   history, then recommends a (model, reasoning-level) pair from an
   explicit allowlist.
3. Side B is generated non-streaming from the recommended combo in
   parallel with Side A.
4. Both responses render side-by-side below the user's message, with a
   "Router says:" line explaining the recommendation.
5. Feedback buttons (Prefer A / Prefer B / Tie / Bad router) persist a
   single row per session in `router_ab_feedback`. The feedback survives
   page reload.

## Architecture

```
components/assistant-ui/
  router-ab-controls.tsx   — reasoning-level dropdown + A/B on/off toggle
  router-ab-panel.tsx      — side-by-side panel + feedback buttons
  thread.tsx               — renders <RouterAbPanel> below the assistant msg
                             when A/B is on

components/settings/
  router-settings-page.tsx — /settings/router client component (form)

lib/router/
  schema.ts        — RouterSettings + parseRouterSettings + parseRouterSettingsForSave
                     + env-var loader
  policy.ts        — pure policy: allowed pool (intersected with settings.allowedCombos),
                     validation, budget guard
  prompts.ts       — system + user prompt for the recommender
  llm-recommend.ts — AI SDK 6 structured-output wrapper (Zod schema, Output.object)
  fake-llm.ts      — deterministic stub for CONTROL_ROOM_FAKE_LLM=1
  graph.ts         — LangGraph StateGraph (5 nodes: prepare → pool → llm_recommend →
                     resolve_recommendation → apply_budget)
  ab-session.ts    — chat-route helpers (recent-turns builder, recentChars)
  settings-store.ts— async, DB-overridable settings resolver (singleton row in
                     router_settings, with a 3s in-process cache)
  settings.test.ts / policy.test.ts / graph.test.ts / fake-llm.test.ts — unit tests

lib/repo/
  router-settings.ts — getRouterSettingsRow / upsertRouterSettingsRow

app/api/chat/route.ts           — runs the router, streams Side A, generates Side B in parallel,
                                  emits data-router-ab and data-router-ab-side-b data parts
app/api/router-ab/feedback/route.ts — GET (current feedback for a session), PUT (record feedback)
app/api/router-ab/session/[id]/route.ts — GET (session row + feedback, for panel re-hydration)
app/api/router-settings/route.ts — GET (effective settings + defaults + registry), PUT (upsert)

app/settings/router/page.tsx    — server wrapper that mounts the client form

db/migrations/
  0004_router_ab.sql                — router_ab_sessions + router_ab_feedback tables
  0005_router_ab_side_b_text.sql    — side_b_text + side_b_latency_ms columns
  0006_router_settings.sql          — router_settings singleton row + CHECK (id = 1)
```

## Safety / budget controls

| Knob                           | Default                                       | Effect                                                                                                    |
| ------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `abEnabled`                    | `true`                                        | Master kill-switch. When `false`, no router runs and Side B is skipped.                                   |
| `allowExpensiveModels`         | `false`                                       | When `false`, expensive-tier models are excluded from the router allowlist.                               |
| `allowLongPromptWhenExpensive` | `false`                                       | When `false`, expensive-tier entries are also excluded if `prompt length >= longPromptThresholdChars`.    |
| `longPromptThresholdChars`     | `1500`                                        | The character threshold for "long prompt".                                                                |
| `maxCostPerRecommendationUsd`  | `0.03`                                        | If the recommendation itself would cost more than this, Side B is skipped.                                |
| `maxCostPerAbRunUsd`           | `0.30`                                        | If Side A + Side B combined would cost more than this, Side B is skipped.                                 |
| `routerModelId`                | `"gpt-5.4-mini"`                              | The model the router uses for its own cheap recommendation call.                                          |
| `fallbackModelId`              | `"gpt-5.4-mini"`                              | Model used when the router output is invalid or rejected.                                                 |
| `fallbackReasoningLevel`       | `"low"`                                       | Reasoning level used when the router output is invalid or rejected.                                       |
| `allowedCombos`                | `[gpt-5.4-mini × low, gpt-5.4-mini × medium]` | Explicit (model, reasoning-level) combos the user has authorized. The Settings UI is the source of truth. |

The first six rows are visible in the Settings UI (`/settings/router`).
The last four (`maxCostPerRecommendationUsd`, `maxCostPerAbRunUsd`,
`routerModelId`, `allowedCombos`) are also visible but `allowedCombos` is
the most-edited one and `maxCost*` are kept in the form payload so a
Save does not silently reset them to defaults — they remain env-only for
new edits. The UI does not expose `routerModelId`.

### Fail-safe paths

| Failure                                                                   | Behavior                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Router call throws / times out (5 s ceiling)                              | Fall back to the cheapest allowlist combo, log `fallbackReason`. Side B still runs.                                                       |
| Router returns a model not in the allowlist                               | Reject and fall back to cheapest combo.                                                                                                   |
| Router returns a disallowed reasoning level for the picked model          | Reject and fall back.                                                                                                                     |
| Router confidence outside `[0, 1]`                                        | Reject and fall back.                                                                                                                     |
| Router returns a valid combo but combined A/B cost > `maxCostPerAbRunUsd` | Skip Side B. Render Side A only with a "skipped because it exceeded the configured budget" notice.                                        |
| `abEnabled = false`                                                       | Skip the router entirely, render Side A only.                                                                                             |
| Empty allowlist (no models in the registry, or all expensive excluded)    | Skip the router, render Side A only.                                                                                                      |
| Side B generation fails (provider 5xx, network)                           | Persist `fallbackReason` to the session row, emit a data-router-ab-side-b chunk with an empty `sideBText`, panel renders the skip notice. |
| `getRouterSettings()` env value is invalid JSON                           | Log a warning and fall back to defaults.                                                                                                  |

## Persistence schema

See `db/migrations/0004_router_ab.sql` and `0005_router_ab_side_b_text.sql`.
A single row in `router_ab_sessions` is created at the start of every
prompt run that has a real `threadId`; the row is patched as Side B
resolves. A single row in `router_ab_feedback` is upserted (toggle-style)
when the user clicks a feedback button. No thread notes, message_feedback,
or other metadata is copied into these tables.

For ad-hoc (no-`threadId`) prompts, the chat route emits the data parts
live but does not persist any row. The panel still renders correctly in
that case; reload re-hydration is not available because there is no row
to fetch back.

## Fake-LLM mode

Set `CONTROL_ROOM_FAKE_LLM=1` to route all three OpenAI calls (router,
Side A, Side B) through deterministic local stubs. The stubs:

- Use the same data shapes as the real path (so the panel renders the
  same way).
- Use a heuristic recommender (keywords → reasoning level) instead of an
  actual GPT-5.4 Mini call.
- Use canned assistant text that mentions the model + reasoning level
  being stubbed.

This is the default for `npm run test:e2e` and is safe to enable in
local development when you don't have a real OpenAI key. Production
should leave `CONTROL_ROOM_FAKE_LLM` unset.

## Out of scope (intentional)

- **Default answer model picker.** Side A is always the user's selected
  combo — there is no "default" model in router settings.
- **Pricing / cost knobs in the UI.** `maxCostPerRecommendationUsd` and
  `maxCostPerAbRunUsd` exist in the persisted payload so the Settings
  UI does not silently reset them, but they are not editable in the UI
  yet — we have not set up reliable pricing metadata.
- **Streaming Side B.** Side B is non-streaming in MVP; it appears as a
  single completion. The `data-router-ab-side-b` data part carries the
  full text once it's ready. Adding streamed Side B is a future task
  that touches the AI SDK v6 stream merge.
- **Learned routing.** The router is a cheap LLM call + deterministic
  policy. No telemetry loop, no feedback-driven fine-tune.
- **Benchmarks / dashboards.** Not shipped; would consume side_b_text +
  router_ab_feedback.

## Settings persistence

The `router_settings` table holds a single row (`id = 1` CHECK
constraint). The Settings UI writes through
`PUT /api/router-settings`, which:

- merges the partial payload with the _current_ effective settings so
  fields the UI does not expose (cost caps, router model id) round-trip
  unchanged;
- validates through `parseRouterSettingsForSave` (allowlist non-empty,
  fallback ∈ allowlist, threshold ≥ 0 or blank, no duplicate combos);
- busts the 3-second in-process cache in `settings-store.ts` so the next
  chat prompt picks up the new allowlist without waiting for the TTL.

The chat route (`/api/chat`) calls `getEffectiveRouterSettings()` once
per request. Order of precedence: persisted singleton → env var →
`DEFAULT_ROUTER_SETTINGS`. A missing or unconfigured DB degrades to the
env path so chat still works offline; the Settings UI itself returns 503
when the DB is missing (it has nothing to write to).

## Validation results (last run)

```
$ npm test
1..52
# tests 52
# suites 0
# pass 52
# fail 0

$ npx playwright test
Running 1 test using 1 worker
  ✓  1 [chromium] › e2e/router-ab.spec.ts:33:5 › router A/B panel renders side-by-side and persists feedback across reload (5.1s)
  1 passed (7.6s)

$ npx tsc --noEmit
(no output)

$ npm run lint
oxlint + oxfmt --check: clean
```
