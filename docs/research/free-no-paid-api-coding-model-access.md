# Free / no-paid-API coding model access research

Date: 2026-07-04

Project context: Control Room + Omnigent as a meta-harness / agent launcher for terminal and coding agents.

## Decision

Use a **hybrid architecture**:

1. **Wire the most valuable free/subscription/local lanes directly into Omnigent as explicit lanes.**
2. Optionally run **OmniRoute underneath Omnigent only as a quarantined Free Aggregator lane**.
3. Do **not** put personal subscriptions, paid API keys, or token-plan accounts inside the same fallback chain as free providers.
4. Keep any general gateway/proxy such as LiteLLM, Helicone Gateway, Portkey, Cloudflare AI Gateway, or Requesty as a lower-level transport/observability layer only when it solves a concrete problem.

This matches the Control Room rule: **no hidden paid fallback, no API-billed fallback unless explicitly approved, and no mixing the same model family across different access paths.**

## Why not one universal router for everything?

A single universal router that contains free accounts, subscriptions, API-billed accounts, and local models is convenient, but it creates the exact failure mode Control Room is meant to prevent:

- a free lane silently falls through to a paid API key;
- a subscription path gets confused with API-billed access;
- the same model family appears under multiple identities, for example `MiniMax M3 Free through OpenCode` vs `MiniMax M3 through MiniMax Token Plan`;
- quota exhaustion becomes ambiguous because the caller sees only `model = minimax-m3`, not the access path;
- billing risk moves from an explicit user decision into router configuration.

The safer design is to make **Omnigent the roof**, not OmniRoute. OmniRoute can sit underneath as one provider category: `free_aggregator`.

## Recommended lane taxonomy

Every lane should carry these fields in Control Room / Omnigent:

```ts
type BillingClass =
  | "free_no_paid_api"
  | "subscription_included"
  | "api_billed"
  | "free_trial_credit"
  | "local_self_hosted";

type FallbackPolicy =
  | "none"
  | "same_billing_class_only"
  | "explicit_user_approval_required";

interface HarnessLane {
  id: string;
  displayName: string;
  providerFamily: string;
  accessPath: string;
  billingClass: BillingClass;
  baseUrl?: string;
  modelAllowlist: string[];
  fallbackPolicy: FallbackPolicy;
  quotaProbe?: string;
  resetWindow?: string;
  status: "available" | "limited" | "quota_exhausted" | "unknown";
}
```

Required naming convention:

```text
<provider-family>/<access-path>/<model>
```

Examples:

```text
minimax/opencode-free/m3-free
minimax/minimax-token-plan/m3
anthropic/claude-code-subscription/sonnet
openai/codex-subscription/gpt-5.5
omniroute/free-aggregator/qwen3-coder
local/ollama/qwen2.5-coder
```

This prevents the UI, logs, and router from treating the same model family as interchangeable across billing/access paths.

## Recommended architecture

```text
                           Control Room UI
                                │
                                ▼
                         Omnigent Router
              explicit lane selection + policy checks
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
  Free / no-paid-API      Subscription-included      API-billed
  lanes                   lanes                      lanes
        │                       │                       │
        │                       │                       │
        │                       │                       │
        ▼                       ▼                       ▼
  ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
  │ OmniRoute Free │      │ Codex sub      │      │ OpenAI API     │
  │ Aggregator     │      │ Claude Code    │      │ Anthropic API  │
  │ optional       │      │ MiniMax plan   │      │ Vertex/API     │
  └────────────────┘      └────────────────┘      └────────────────┘
        │
        ▼
  Free-only provider chain
  Gemini CLI / Code Assist
  OpenCode Free / Zen free models
  OpenRouter free models
  Qwen/Kimi/DeepSeek free routes if verified
  Groq/NVIDIA/HF free tiers if verified

        ┌───────────────────────────────────────────────┐
        ▼                                               │
  Local/self-hosted lane                                │
  Ollama / LM Studio / llama.cpp / vLLM                 │
  no external billing                                   │
        └───────────────────────────────────────────────┘
```

## Findings by option

| Option | Best role | Recommendation |
|---|---|---|
| OmniRoute | Free-provider aggregation | Use only as `Free Aggregator` under Omnigent. Do not mix paid/subscription keys into its combos. Treat brittle providers as experimental. |
| LiteLLM | Stable self-hosted OpenAI-compatible proxy and budget enforcement | Useful later for internal gateway policy, not necessary for maximizing free coding access. Avoid using it as one giant mixed billing router. |
| OpenRouter | Hosted model aggregator with some free models | Add as a separate `free_no_paid_api` lane only for explicitly free model IDs. Do not top up credits unless the lane is reclassified as API-billed or credit-backed. |
| Portkey | Production gateway / routing / guardrails | Not primarily free-focused. Avoid unless you need enterprise-style gateway behavior. |
| Requesty | Hosted free-model API and coding-tool-friendly gateway | Good experimental lane if its free tier remains truly free and blocks paid models by default. Keep separate from subscriptions. |
| Helicone Gateway | Observability and gateway layer | Good for logs/monitoring later. It does not inherently maximize free access. |
| Cloudflare AI Gateway | Hosted gateway and observability | Useful if you already want Cloudflare-managed gatewaying. BYOK means it does not create free model access by itself. |
| Direct provider CLIs/accounts | Highest trust and clearest billing semantics | Best first step. Wire each durable free/subscription/local source directly as an explicit lane. |
| Local models | Zero external billing | Add later as local lanes once hardware and quality are acceptable. |

## Best sources to add first

Priority order for Control Room + Omnigent:

1. **OpenCode Free / Zen free models**
   - Already aligned with terminal/coding harness use.
   - Must be kept separate from MiniMax Token Plan.
   - Lane examples:
     - `opencode/free/big-pickle-free`
     - `opencode/free/deepseek-v4-flash-free`
     - `opencode/free/north-mini-code-free`

2. **Gemini CLI / Gemini Code Assist free path**
   - Strong practical free lane for terminal coding.
   - Must be configured so it does not auto-switch to paid Vertex/API usage.
   - Lane example: `google/gemini-cli-free/gemini-code-assist`.

3. **OpenRouter free models**
   - Useful as a low-effort OpenAI-compatible endpoint.
   - Strictly allowlist model IDs that are marked free.
   - Treat request limits as expected, not failure.

4. **OmniRoute as an experimental free aggregator**
   - Useful for pooling many free accounts/providers.
   - Add only after direct lanes exist, so Omnigent can compare reliability and avoid lock-in.
   - Must be configured with free providers only.

5. **Local models**
   - Add once you are ready for Ollama / LM Studio / llama.cpp.
   - Best for privacy, offline work, and no external billing.

6. **Existing subscriptions**
   - Codex Subscription, Claude Code subscription, MiniMax Token Plan.
   - Keep these under `subscription_included`, not `free_no_paid_api`.
   - No fallback from free to these without explicit approval.

## What to avoid

Avoid these patterns:

```text
Free lane → subscription lane fallback
Free lane → API-billed fallback
OpenRouter free → OpenRouter paid credits fallback
Gemini CLI free → Vertex paid fallback
MiniMax free alias → MiniMax token-plan alias reuse
Claude via free aggregator → Claude Code subscription alias reuse
One generic `minimax-m3` model ID shared by multiple access paths
```

Avoid presenting free-trial credits as free. Free trial credits should be a separate class:

```text
billingClass = "free_trial_credit"
fallbackPolicy = "explicit_user_approval_required"
```

## Recommended implementation plan

### Phase 1 — Lane registry and policy guard

Add a lane registry table/config with:

- lane ID
- provider family
- access path
- billing class
- endpoint/base URL
- allowed model IDs
- fallback policy
- quota/status probe
- enabled/disabled flag

Add a hard policy check before every run:

```ts
function assertAllowedFallback(from: HarnessLane, to: HarnessLane) {
  if (from.fallbackPolicy === "none") {
    throw new Error(`Fallback disabled for ${from.id}`);
  }

  if (from.fallbackPolicy === "same_billing_class_only") {
    if (from.billingClass !== to.billingClass) {
      throw new Error(
        `Blocked fallback from ${from.billingClass} lane ${from.id} to ${to.billingClass} lane ${to.id}`
      );
    }
  }

  if (to.billingClass === "api_billed" || to.billingClass === "free_trial_credit") {
    throw new Error(
      `Explicit approval required before using billable/credit-backed lane ${to.id}`
    );
  }
}
```

### Phase 2 — Direct lanes first

Implement explicit lanes for:

```text
opencode/free/*
google/gemini-cli-free/*
openrouter/free/*
minimax/minimax-token-plan/*
openai/codex-subscription/*
anthropic/claude-code-subscription/*
```

Make each lane visible in the UI with billing class and access path.

### Phase 3 — Optional OmniRoute Free Aggregator

Add OmniRoute as one lane:

```text
lane.id = "omniroute/free-aggregator"
billingClass = "free_no_paid_api"
fallbackPolicy = "same_billing_class_only"
baseUrl = "http://127.0.0.1:<port>/v1"
modelAllowlist = ["only-free-combos"]
```

Rules:

- no paid keys in OmniRoute;
- no subscription keys in OmniRoute;
- no API-billed fallback combos;
- name combos after access path, not just model family;
- fail closed if OmniRoute quota/status is unknown and the run is marked `free_only_required`.

### Phase 4 — Observability and quota dashboard

Track per run:

```text
run_id
lane_id
provider_family
access_path
billing_class
model_id
fallback_from_lane_id
explicit_approval_id, if any
quota_status_before
quota_status_after
estimated_cost
actual_cost, if available
```

Control Room should show:

```text
Free lanes: available / limited / exhausted / unknown
Subscription lanes: available / limited / unknown
API-billed lanes: locked unless approved
Local lanes: online / offline / model missing
```

## Direct answer: should OmniRoute and subscriptions live under one roof?

Yes, but the roof should be **Omnigent**, not OmniRoute.

Recommended:

```text
Omnigent
├── Free Aggregator lane: OmniRoute, free-only
├── Direct Free lanes: OpenCode Free, Gemini CLI, OpenRouter Free
├── Subscription lanes: Codex Subscription, Claude Code, MiniMax Token Plan
├── API-billed lanes: explicit approval only
└── Local lanes: Ollama / LM Studio / llama.cpp
```

Not recommended:

```text
OmniRoute
├── free providers
├── Codex subscription
├── Claude Code subscription
├── MiniMax Token Plan
└── API-billed keys
```

That would be one roof in the dangerous sense: convenient, but too easy to hide paid fallback and blur access paths.

## Final verdict

Use a **hybrid approach**.

- **Use Omnigent as the policy roof.**
- **Wire important direct free/subscription/local lanes explicitly.**
- **Use OmniRoute only as an optional free-only aggregator lane.**
- **Do not use OmniRoute as the global router for your subscriptions.**
- **Do not put API-billed keys into any automatic fallback chain.**

If you later need a stable internal gateway, evaluate LiteLLM or Helicone Gateway beneath Omnigent, but keep billing classes separated there too. For the near term, direct lanes plus a quarantined OmniRoute free lane is the cleanest and safest architecture.

## Source notes from research

The investigation reviewed official docs, GitHub pages, and community/user reports for OmniRoute, LiteLLM, OpenRouter, Portkey, Requesty, Helicone Gateway, Cloudflare AI Gateway, OpenCode Zen, Gemini CLI, Cursor Free, and related free-provider lists. Specific source claims should be re-verified before implementing any provider whose free tier is unofficial, community-reported, or likely to change.
