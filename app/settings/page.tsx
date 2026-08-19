import { SettingsIndexPage } from "@/components/settings/index-page";

/**
 * /settings — landing page that lists available settings sub-pages.
 *
 * Currently:
 *   - Router Settings: requires Postgres
 *   - Agent Backends: independent of Postgres (reads Codex CLI on host)
 *
 * The page itself is a thin wrapper around the client component
 * above. We keep the route as a server component so cross-cutting
 * concerns (auth, metadata, breadcrumbs) can be added later without
 * forcing the client component to become a server component.
 */
export default function SettingsRoute() {
  return <SettingsIndexPage />;
}
