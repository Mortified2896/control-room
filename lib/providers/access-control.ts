import "server-only";

import { isDbConfigured, tryDb, withClient } from "@/lib/db";
import { getModelMeta } from "@/lib/providers";
import { getMiniMaxDiscoverySnapshot } from "@/lib/repo/minimax-models-discovery";
import { getMiniMaxConfig } from "./minimax";
import type { ReasoningLevel } from "./types";

export type StableProviderId = "codex_subscription" | "openai_api" | "minimax_api";
export type ExecutionSurface = "manual_chat" | "router" | "backend_test" | "smoke_test";
export type BillingType = "included_subscription" | "usage_billed" | "token_plan";

export type ProviderAccessSettings = {
  provider_id: StableProviderId;
  display_name: string;
  enabled: boolean;
  allow_manual: boolean;
  allow_router: boolean;
  allow_backend_test: boolean;
  requires_confirmation_when_enabling: boolean;
  billing_type: BillingType;
  access_label: string;
  status: string;
};

const PROVIDERS: Record<
  StableProviderId,
  Omit<
    ProviderAccessSettings,
    "enabled" | "allow_manual" | "allow_router" | "allow_backend_test" | "status"
  >
> = {
  codex_subscription: {
    provider_id: "codex_subscription",
    display_name: "Codex subscription",
    billing_type: "included_subscription",
    access_label: "Codex CLI + ChatGPT login",
    requires_confirmation_when_enabling: false,
  },
  openai_api: {
    provider_id: "openai_api",
    display_name: "OpenAI API",
    billing_type: "usage_billed",
    access_label: "OPENAI_API_KEY",
    requires_confirmation_when_enabling: true,
  },
  minimax_api: {
    provider_id: "minimax_api",
    display_name: "MiniMax API key",
    billing_type: "token_plan",
    access_label: "MINIMAX_API_KEY",
    requires_confirmation_when_enabling: false,
  },
};

export function stableProviderId(providerId: string): StableProviderId {
  if (providerId === "openai" || providerId === "openai_api") return "openai_api";
  if (providerId === "minimax" || providerId === "minimax_api") return "minimax_api";
  if (providerId === "codex" || providerId === "codex_subscription") return "codex_subscription";
  throw new Error(`Unknown provider: ${providerId}`);
}

function envDefault(id: StableProviderId): ProviderAccessSettings {
  const base = PROVIDERS[id];
  if (id === "openai_api") {
    const key = Boolean(process.env.OPENAI_API_KEY?.trim());
    return {
      ...base,
      enabled: false,
      allow_manual: false,
      allow_router: false,
      allow_backend_test: false,
      status: key ? "Key found; disabled by default" : "OPENAI_API_KEY not configured",
    };
  }
  if (id === "minimax_api") {
    const key = Boolean(process.env.MINIMAX_API_KEY?.trim());
    return {
      ...base,
      enabled: key,
      allow_manual: key,
      allow_router: false,
      allow_backend_test: key,
      status: key ? "Configured" : "MINIMAX_API_KEY not configured",
    };
  }
  const connected = Boolean(process.env.CODEX_HOME?.trim() || process.env.HOME?.trim());
  return {
    ...base,
    enabled: connected,
    allow_manual: connected,
    allow_router: connected,
    allow_backend_test: connected,
    status: connected ? "Available" : "Not connected",
  };
}

export function defaultProviderAccessSettings(): ProviderAccessSettings[] {
  return [envDefault("codex_subscription"), envDefault("openai_api"), envDefault("minimax_api")];
}

export async function getProviderAccessSettings(): Promise<ProviderAccessSettings[]> {
  const defaults = defaultProviderAccessSettings();
  if (!isDbConfigured()) return defaults;
  const rows = await tryDb(
    async (c) => {
      const res = await c.query<
        Partial<ProviderAccessSettings> & { provider_id: StableProviderId }
      >(
        "select provider_id, enabled, allow_manual, allow_router, allow_backend_test from provider_access_settings",
      );
      return res.rows;
    },
    [] as Array<Partial<ProviderAccessSettings> & { provider_id: StableProviderId }>,
  );
  const byId = new Map(rows.map((r) => [r.provider_id, r]));
  return defaults.map((d) => {
    const row = byId.get(d.provider_id);
    return row ? { ...d, ...row } : d;
  });
}

export async function updateProviderAccessSettings(
  patch: Array<Pick<ProviderAccessSettings, "provider_id"> & Partial<ProviderAccessSettings>>,
) {
  if (!isDbConfigured()) throw new Error("db_not_configured");
  await withClient(async (c) => {
    for (const p of patch) {
      const id = stableProviderId(p.provider_id);
      await c.query(
        `insert into provider_access_settings (provider_id, enabled, allow_manual, allow_router, allow_backend_test)
         values ($1, $2, $3, $4, $5)
         on conflict (provider_id) do update set enabled=$2, allow_manual=$3, allow_router=$4, allow_backend_test=$5, updated_at=now()`,
        [
          id,
          Boolean(p.enabled),
          Boolean(p.allow_manual),
          Boolean(p.allow_router),
          Boolean(p.allow_backend_test),
        ],
      );
    }
  });
}

export class ProviderAccessError extends Error {
  status = 403;
  constructor(
    public providerId: StableProviderId,
    message: string,
  ) {
    super(message);
  }
}

export async function assertModelExecutionAllowed(args: {
  providerId: string;
  modelId: string;
  surface: ExecutionSurface;
  reasoningLevel?: ReasoningLevel | null;
}) {
  const providerId = stableProviderId(args.providerId);
  const provider = (await getProviderAccessSettings()).find((p) => p.provider_id === providerId);
  if (!provider) throw new ProviderAccessError(providerId, "Provider does not exist in Settings.");
  if (!provider.enabled) {
    if (providerId === "openai_api")
      throw new ProviderAccessError(
        providerId,
        "OpenAI API provider is disabled in Settings. Enable it explicitly to use usage-billed API models.",
      );
    throw new ProviderAccessError(
      providerId,
      `${provider.display_name} provider is disabled in Settings.`,
    );
  }
  const allowed =
    args.surface === "router"
      ? provider.allow_router
      : args.surface === "manual_chat"
        ? provider.allow_manual
        : provider.allow_backend_test;
  if (!allowed)
    throw new ProviderAccessError(
      providerId,
      `${provider.display_name} is not allowed for ${args.surface} in Settings.`,
    );
  if (providerId !== "codex_subscription") {
    const meta = getModelMeta(args.modelId);
    if (!meta && providerId === "minimax_api") {
      const snapshot = await getMiniMaxDiscoverySnapshot();
      const config = getMiniMaxConfig();
      const allowedIds = new Set(
        snapshot.modelIds.length > 0 ? snapshot.modelIds : [config.defaultModel],
      );
      if (!allowedIds.has(args.modelId)) {
        throw new ProviderAccessError(
          providerId,
          "Model does not belong to the requested provider.",
        );
      }
      return;
    }
    if (!meta || stableProviderId(meta.providerId) !== providerId)
      throw new ProviderAccessError(providerId, "Model does not belong to the requested provider.");
    if (
      args.reasoningLevel &&
      meta.reasoningLevels.length > 0 &&
      !meta.reasoningLevels.includes(args.reasoningLevel)
    ) {
      throw new ProviderAccessError(
        providerId,
        `Reasoning level ${args.reasoningLevel} is not supported by ${args.modelId}.`,
      );
    }
  }
}
