This is the [assistant-ui](https://github.com/assistant-ui/assistant-ui) minimal starter project.

## Getting Started

### 1. Configure Environment Variables

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

### 2. Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

### 3. Run the Development Server

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Development

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

See `lib/router/settings.ts` for the full settings surface; no Settings UI
is shipped in the MVP — set values via the `CONTROL_ROOM_ROUTER_SETTINGS`
env var (see `.env.example`).

## Tests

```bash
npm run typecheck     # tsc --noEmit
npm run lint         # oxlint + oxfmt --check
npm test             # node:test unit tests (policy, graph, settings, fake-llm)
npm run db:migrate   # apply pending SQL migrations
npm run build        # production build
npm run test:e2e     # Playwright (requires CONTROL_ROOM_FAKE_LLM=1 or OPENAI_API_KEY)
```
