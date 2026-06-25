import { RouterSettingsPage } from "@/components/settings/router-settings-page";

/**
 * /settings/router — interactive editor for the Router Settings singleton.
 *
 * The page itself is a thin wrapper around the client component below; we
 * keep the route as a server component so future cross-cutting concerns
 * (auth, page-level metadata, breadcrumbs) can be added without making
 * the form a server component.
 *
 * The DB must be configured for this page to do anything useful. The
 * client component fetches `/api/router-settings`, which returns 503 when
 * the DB is unconfigured; the client surfaces that as a clear inline
 * "DB is not configured" message instead of pretending the page works.
 */
export default function RouterSettingsRoute() {
  return <RouterSettingsPage />;
}
