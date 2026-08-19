import "server-only";

import { tryDb, withTransaction } from "@/lib/db";
import { HARNESS_REGISTRY } from "@/lib/harness/registry";
import {
  CODING_MODEL_FALLBACK_REASONS,
  DEFAULT_CODING_MODEL_ROUTING_POLICY,
  type CodingModelFallbackReason,
  type CodingModelRoutingPolicy,
} from "@/lib/harness/model-routing";

export const CODING_MODEL_ROUTING_SETTINGS_SINGLETON_ID = 1 as const;
export const CODING_MODEL_ROUTING_SETTINGS_SCHEMA_VERSION = 2 as const;

export type CodingModelRoutingSettingsDto = {
  defaultRouteModel: string;
  defaultRouteFallbackModel: string;
  largeContextRouteModel: string;
  largeContextRouteFallbackModel: string;
  thresholdTokens: number;
  fallbackReasons: CodingModelFallbackReason[];
};

export type ValidationError = { field: string; message: string };

export function codingPolicyToSettings(policy: CodingModelRoutingPolicy): CodingModelRoutingSettingsDto {
  return {
    defaultRouteModel: policy.standardModelId,
    defaultRouteFallbackModel: policy.defaultRouteFallbackModelId ?? "",
    largeContextRouteModel: policy.largeContextModelId,
    largeContextRouteFallbackModel: policy.largeContextRouteFallbackModelId ?? "",
    thresholdTokens: policy.largeContextThresholdTokens,
    fallbackReasons: [...policy.enabledFallbackReasons],
  };
}

export function settingsToCodingPolicy(settings: CodingModelRoutingSettingsDto): CodingModelRoutingPolicy {
  return {
    standardModelId: settings.defaultRouteModel,
    largeContextModelId: settings.largeContextRouteModel,
    largeContextThresholdTokens: settings.thresholdTokens,
    defaultRouteFallbackModelId: settings.defaultRouteFallbackModel,
    largeContextRouteFallbackModelId: settings.largeContextRouteFallbackModel,
    enabledFallbackReasons: settings.fallbackReasons,
  };
}

export const DEFAULT_CODING_MODEL_ROUTING_SETTINGS = codingPolicyToSettings(DEFAULT_CODING_MODEL_ROUTING_POLICY);

export function listCodingRouteEligibleModelIds(): string[] {
  return Array.from(
    new Set([
      ...HARNESS_REGISTRY.flatMap((h) => h.allowedModelIds),
      ...HARNESS_REGISTRY.flatMap((h) => h.allowedModelIds.map((id) => `${h.id === "codex_cli" ? "codex" : "minimax"}:${id}`)),
      DEFAULT_CODING_MODEL_ROUTING_POLICY.standardModelId,
      DEFAULT_CODING_MODEL_ROUTING_POLICY.largeContextModelId,
      DEFAULT_CODING_MODEL_ROUTING_POLICY.defaultRouteFallbackModelId ?? "",
      DEFAULT_CODING_MODEL_ROUTING_POLICY.largeContextRouteFallbackModelId ?? "",
    ].filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
}

export function parseCodingModelRoutingSettings(input: unknown):
  | { ok: true; value: CodingModelRoutingSettingsDto }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const obj = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!obj) return { ok: false, errors: [{ field: "settings", message: "Settings must be an object." }] };

  const modelIds = new Set(listCodingRouteEligibleModelIds());
  const readModel = (field: string, aliases: string[] = []): string => {
    const sourceField = [field, ...aliases].find((f) => typeof obj[f] === "string" && (obj[f] as string).trim());
    const value = sourceField ? obj[sourceField] : undefined;
    if (typeof value !== "string" || !value.trim()) {
      errors.push({ field, message: "Model id is required." });
      return "";
    }
    const model = normalizeLegacyCodingModelId(value.trim());
    if (!modelIds.has(model)) errors.push({ field, message: `Unknown coding harness model id: ${model}` });
    return model;
  };

  const defaultRouteModel = readModel("defaultRouteModel", ["standardModel"]);
  const largeContextRouteModel = readModel("largeContextRouteModel", ["largeContextModel"]);
  const defaultRouteFallbackModel = readModel("defaultRouteFallbackModel", ["failureFallbackModel"]);
  const largeContextRouteFallbackModel = readModel("largeContextRouteFallbackModel", ["failureFallbackModel"]);
  if (defaultRouteFallbackModel && defaultRouteFallbackModel !== "MiniMax-M3") {
    errors.push({ field: "defaultRouteFallbackModel", message: "Fallback model must be MiniMax-M3; API-billed provider fallback is not allowed." });
  }
  if (largeContextRouteFallbackModel && largeContextRouteFallbackModel !== "MiniMax-M3") {
    errors.push({ field: "largeContextRouteFallbackModel", message: "Fallback model must be MiniMax-M3; API-billed provider fallback is not allowed." });
  }

  const threshold = obj.thresholdTokens;
  let thresholdTokens = 0;
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1_000 || threshold > 10_000_000) {
    errors.push({ field: "thresholdTokens", message: "Threshold must be an integer between 1,000 and 10,000,000 tokens." });
  } else {
    thresholdTokens = threshold;
  }

  const rawReasons = Array.isArray(obj.fallbackReasons) ? obj.fallbackReasons : obj.enabledFallbackReasons;
  const recognized = new Set<string>(CODING_MODEL_FALLBACK_REASONS);
  const fallbackReasons: CodingModelFallbackReason[] = [];
  if (!Array.isArray(rawReasons)) {
    errors.push({ field: "fallbackReasons", message: "Fallback reasons must be an array." });
  } else {
    for (const reason of rawReasons) {
      if (reason === "unknown_usage") {
        errors.push({ field: "fallbackReasons", message: "Unknown usage cannot be configured as a fallback trigger." });
      } else if (typeof reason !== "string" || !recognized.has(reason)) {
        errors.push({ field: "fallbackReasons", message: `Unknown fallback reason: ${String(reason)}` });
      } else if (!fallbackReasons.includes(reason as CodingModelFallbackReason)) {
        fallbackReasons.push(reason as CodingModelFallbackReason);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { defaultRouteModel, defaultRouteFallbackModel, largeContextRouteModel, largeContextRouteFallbackModel, thresholdTokens, fallbackReasons } };
}

function normalizeLegacyCodingModelId(modelId: string): string {
  if (modelId === "gpt-5.5-small" || modelId === "codex:gpt-5.5-small") return "codex:gpt-5.5";
  return modelId;
}

export async function getPersistedCodingModelRoutingSettings(): Promise<CodingModelRoutingSettingsDto | null> {
  return tryDb(async (c) => {
    const { rows } = await c.query<{ settings: unknown }>("SELECT settings FROM coding_model_routing_settings WHERE id = $1", [CODING_MODEL_ROUTING_SETTINGS_SINGLETON_ID]);
    const row = rows[0];
    if (!row) return null;
    const parsed = parseCodingModelRoutingSettings(row.settings);
    return parsed.ok ? parsed.value : DEFAULT_CODING_MODEL_ROUTING_SETTINGS;
  }, null);
}

export async function upsertCodingModelRoutingSettings(input: { settings: unknown; updatedBy?: string | null }): Promise<{ ok: true; value: CodingModelRoutingSettingsDto } | { ok: false; errors: ValidationError[] }> {
  const parsed = parseCodingModelRoutingSettings(input.settings);
  if (!parsed.ok) return parsed;
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO coding_model_routing_settings (id, settings, schema_version, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET settings = EXCLUDED.settings,
           schema_version = EXCLUDED.schema_version,
           updated_by = EXCLUDED.updated_by`,
      [CODING_MODEL_ROUTING_SETTINGS_SINGLETON_ID, JSON.stringify(parsed.value), CODING_MODEL_ROUTING_SETTINGS_SCHEMA_VERSION, input.updatedBy ?? null],
    );
  });
  return { ok: true, value: parsed.value };
}
