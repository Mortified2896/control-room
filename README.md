# Control Room

Control Room is evolving into a coding-agent observability, replay, and evaluation system around Omnigent, OmniRoute, OpenTelemetry, optional downstream analytics/evaluation consumers such as MLflow, reproducible sandbox state, and later benchmark/evaluation tooling.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the current implementation and evaluation plan.

Current sequence:

1. Keep the validated local Mac OpenTelemetry capture path healthy, finish server source-of-truth revalidation when connectivity returns, and keep MLflow optional downstream.
2. Add Daytona for reproducible sandbox state, snapshots, and forks.
3. Prove genuine replay from an identical pre-agent workspace.
4. Add Harbor for portable benchmark tasks and objective verification.
5. Add Inspect / Inspect SWE for controlled harness × model experiments.
6. Accumulate a high-quality replay corpus before using the evidence to improve OmniRoute routing.

---

## Existing UI prototype

This repository currently contains the original [assistant-ui](https://github.com/assistant-ui/assistant-ui) minimal starter project.

### Getting Started

#### 1. Configure Environment Variables

Add your OpenAI API key to a `.env.local` file:

```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For the Router A/B mode MVP, no other env vars are required. To run the
chat end-to-end without burning real OpenAI tokens during local development
or Playwright runs, set:

```
CONTROL_ROOM_FAKE_LLM=1
```

This swaps the router recommender + Side A + Side B calls for deterministic
local stubs. Production should leave `CONTROL_ROOM_FAKE_LLM` unset.

#### 2. Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

#### 3. Run the Development Server

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Development

You can start customizing the UI by modifying components in the `components/assistant-ui/` directory.

To add more assistant-ui components:

```bash
npx assistant-ui add
```

### Key Files

- `app/assistant.tsx` - Sets up the runtime provider
- `app/api/chat/route.ts` - Chat API endpoint
- `components/assistant-ui/thread.tsx` - Chat thread component
- `lib/router/` - LangGraph router graph + AI SDK 6 recommender
- `lib/repo/router-ab.ts` - Router A/B session + feedback persistence
- `db/migrations/0004_router_ab.sql`, `db/migrations/0005_router_ab_side_b_text.sql` - Router A/B persistence

## Local Codex telemetry (macOS)

The repository includes a user-level, localhost-only OpenTelemetry Collector setup for the Codex desktop app. It writes a privacy-reduced lean archive plus a three-day forensic trace tier, with Mac-only 60-day/50 GB aggregate retention:

```bash
./scripts/otel/install-macos.sh
./scripts/otel/status.sh
./scripts/otel/check.sh --since 1h
./scripts/otel/audit.sh
./scripts/otel/audit.sh --json
```

See [docs/mac-codex-opentelemetry.md](docs/mac-codex-opentelemetry.md) for architecture, privacy, retention, identity, and uninstall details. The installer validates the merged `~/.codex/config.toml` before writing it atomically and keeps a UTC timestamped backup; `python3 scripts/otel/control_room_otel.py rollback` restores it.

## Router A/B Mode (experimental)

Toggle the **A/B** switch in the composer header to enable Router A/B mode.
Each prompt runs through your selected model **and** a cheap GPT-5.4 Mini
recommender that picks a model + reasoning-level combo for Side B. Both
sides render side-by-side, with a "Router says:" line above Side B
explaining the choice.

- The router **never** overrides your selected model — Side A always uses
  exactly the model + reasoning level you picked.
- The router **never** chooses from every model that is technically
  available. It picks from an explicit allowlist of (model, reasoning-level)
  pairs declared in `lib/providers/openai.ts`.
- Expensive-tier model + high reasoning requires `allowExpensiveModels=true`
  in router settings. Off by default.
- Long prompts auto-exclude expensive combos unless
  `allowLongPromptWhenExpensive=true`. Off by default.
- If the router call itself would cost more than
  `maxCostPerRecommendationUsd` (default 0.03 USD), Side B is skipped.
- If Side A + Side B combined would cost more than `maxCostPerAbRunUsd`
  (default 0.30 USD), Side B is skipped.
- Persisted feedback (Prefer A / Prefer B / Tie / Bad router) is recorded
  in `router_ab_feedback` and survives page reload.

See `lib/router/schema.ts` for the full settings surface. The Settings UI
at `/settings/router` writes to a singleton row in Postgres; the env var
remains the fallback when the DB is not configured (see `.env.example`).

## Recommend-model toggle

Toggle **Recommend on/off** in the composer to have a cheap recommender
pick the chat model + reasoning option before a message goes out.

- **Off**: the composer sends with the model you picked in the manual selector.
- **On**: Send calls `/api/model/recommend` first and shows a banner with the
  recommendation. Accept switches to the recommended model; decline sends with
  your current manual model.

The normal-chat recommender model is separate from the A/B router model and
from the manual chat selector. Configure it under Settings → Router →
Normal-chat recommender model.

## Tests

```bash
npm run typecheck     # tsc --noEmit
npm run lint         # oxlint + oxfmt --check
npm test             # node:test unit tests (policy, graph, settings, fake-llm)
npm run db:migrate   # apply pending SQL migrations
npm run build        # production build
npm run test:e2e     # Playwright (requires CONTROL_ROOM_FAKE_LLM=1 or OPENAI_API_KEY)
```
