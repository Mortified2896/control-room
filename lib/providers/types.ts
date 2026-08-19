export type ModelOption = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  enabled: boolean;
  reason?: string;
};

export type ModelsResponse = {
  models: ModelOption[];
  defaultModelId: string | null;
};

export type ResolvedModel = {
  providerId: string;
  modelId: string;
};

export type ResolveError =
  | { kind: "unknown_model"; modelId: string; allowedIds: string[] }
  | { kind: "provider_disabled"; providerId: string; reason: string }
  | { kind: "no_models_available" };

export type ResolveResult =
  | { ok: true; resolved: ResolvedModel }
  | { ok: false; error: ResolveError };
