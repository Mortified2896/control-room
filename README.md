# Control Room Standalone

> **STATUS: DORMANT / PRESERVED / NOT THE CURRENT CONTROL ROOM PLATFORM**
>
> This repository contains the historical standalone TypeScript/Next.js Control Room application. It is preserved so the standalone product can be revived deliberately later.
>
> **Do not use this repository for Omnigent, O1, O2, current Control Room agent-platform, Hatchet/Autopilot integration, server deployment, or HomeLab work.**

Current ownership:

- [Mortified2896/omnigent](https://github.com/Mortified2896/omnigent) — current Control Room/Omnigent product, agent runtime, O1/O2 application, and deployment logic.
- [Mortified2896/HomeLab](https://github.com/Mortified2896/HomeLab) — server, systemd, Docker, networking, Tailscale, storage, observability deployment, and operations.
- [Mortified2896/omniroute-customizations](https://github.com/Mortified2896/omniroute-customizations) — OmniRoute catalog and routing overlays.

Work may proceed here only when the task explicitly names this standalone application and says it is being revived, or when preserving/migrating historical evidence. Historical branches, PRs, Mac telemetry tooling, and the closed Hatchet pilot are intentionally retained; their presence does not make this repository an active current-platform source.

This repository is expected to be renamed to an unmistakable standalone name and archived read-only after preservation is complete. Archival is reversible and does not delete its Git history.

---

## Preserved historical README

The material below is retained for context and possible future standalone revival. It is **not** the current Control Room roadmap or repository-routing authority.

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
