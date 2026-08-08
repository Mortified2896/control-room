# Control Room

Control Room is evolving into a coding-agent observability, replay, and evaluation system around Omnigent, OmniRoute, MLflow, reproducible sandbox state, and later benchmark/evaluation tooling.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the current implementation and evaluation plan.

Current sequence:

1. Stabilize privacy-safe, low-noise MLflow production tracing.
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
