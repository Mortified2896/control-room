This is the [assistant-ui](https://github.com/assistant-ui/assistant-ui) minimal starter project.

## Getting Started

### 1. Configure Environment Variables

Add your OpenAI API key to a `.env.local` file:

```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

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

## Local Codex telemetry (macOS)

The repository includes a user-level, localhost-only OpenTelemetry Collector setup for the Codex desktop app:

```bash
./scripts/otel/install-macos.sh
./scripts/otel/status.sh
./scripts/otel/check.sh --since 1h
```

See [docs/mac-codex-opentelemetry.md](docs/mac-codex-opentelemetry.md) for architecture, privacy, retention, identity, and uninstall details. The installer validates the merged `~/.codex/config.toml` before writing it atomically and keeps a UTC timestamped backup; `python3 scripts/otel/control_room_otel.py rollback` restores it.
