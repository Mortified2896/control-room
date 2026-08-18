# Control Room Engineering Guidelines

## Default tech stack

Use these choices unless explicitly instructed otherwise:

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Assistant UI
- AI SDK 6
- LangGraph
- Postgres
- Langfuse
- Playwright

## Architecture rules

- Keep Next.js as the main application framework.
- Use Assistant UI for chat interfaces.
- Use AI SDK 6 as the model/provider abstraction.
- Use Postgres as the primary database.
- Use Langfuse for tracing, observability, prompt experiments, and evaluations.
- Use shadcn/ui components before creating custom UI primitives.
- Use Playwright for browser, UI, interaction, and visual debugging.