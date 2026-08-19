import { AgentBackendsPage } from "@/components/settings/agent-backends-page";

/**
 * /settings/agent-backends — Codex backend test surface.
 *
 * The page itself is a thin wrapper around the client component below.
 * No DB access is required; the Codex status endpoint is independent
 * of Postgres.
 */
export default function AgentBackendsRoute() {
  return <AgentBackendsPage />;
}
