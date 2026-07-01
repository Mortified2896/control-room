# Model Routing Semantics: Router Engines vs Execution Models

This document is the source of truth for Control Room model-routing semantics.
Future routing, recommender, coding harness, and settings changes must preserve
this separation.

## Absolute rule

Control Room must never use deterministic routing to select the execution model.

Deterministic metadata such as prompt length, context size, token estimates,
harness availability, or cost estimates may be used as guardrails or to choose
which recommender lane to ask. It must not directly choose the model that will
execute the user's prompt or coding task.

## Definitions

- **Router / recommender engine**: A model used to decide. It evaluates the
  request, available authorized execution models, constraints, and context, then
  recommends the execution model and reasoning/thinking level. The router model
  is not the execution model by default.

- **Fallback recommender**: A second configured router / recommender engine paired
  with a primary recommender. It is attempted only when that paired primary
  recommender fails. A fallback recommender is also a decision engine; it is not
  the execution model by default.

- **Recommender lane**: The configured pair of recommender engines selected for a
  recommendation request. A lane may be chosen from deterministic metadata, for
  example default lane for ordinary prompts and long-prompt lane for large
  prompt/context requests. Lane selection only decides which recommender pair is
  asked.

- **Execution model**: The model that actually answers the chat request or runs a
  coding harness task. It must come from the recommender result, an explicit user
  override, or another explicitly named non-router source. It must not be chosen
  directly by token threshold, default deterministic policy, router-engine model
  id, or router-fallback model id.

## Flow diagram

```text
User prompt + context
        |
        v
Decision router / classifier
(normal chat vs coding task / harness path)
        |
        v
Deterministic metadata may choose recommender lane only
(default recommender pair vs long-prompt recommender pair)
        |
        v
Primary recommender engine evaluates authorized execution candidates
        |                 \
        | success          \ failure, visibly recorded
        v                   v
Recommendation result       Paired fallback recommender engine
(execution model +          |                 \
 reasoning + reason)        | success          \ failure, loudly blocked
        |                   v                  v
        +------------> Recommendation result   No execution model selected
                       (execution model +      user must retry/change settings/
                        reasoning + reason)   explicitly override
        |
        v
Execution model runs normal chat / Codex CLI / MiniMax CLI / other approved path
```

## Forbidden examples

These patterns are not allowed in Control Room model selection:

- Prompt length under threshold → execute with model A.
- Prompt length over threshold → execute with model B.
- Configured router model is `X` → execute the user prompt with `X`.
- Configured router fallback model is `Y` → execute the user prompt with `Y`.
- Recommender failed → silently use a default execution model.
- Primary recommender failed → silently try unrelated providers or hidden defaults.
- Fallback recommender failed → still select a model from static policy.
- OpenAI API-billed recommender or execution fallback unless explicitly enabled by
  existing settings and surfaced in diagnostics.

## Allowed examples

These patterns are allowed:

- Prompt/context length chooses the **long-prompt recommender lane**; that lane's
  recommender engine then chooses the execution model from authorized candidates.
- Ordinary prompt chooses the **default recommender lane**; that lane's
  recommender engine then chooses the execution model from authorized candidates.
- Primary recommender fails; its configured fallback recommender is attempted,
  diagnostics show both primary failure and fallback attempt, and the fallback's
  recommendation supplies the execution model.
- Both primary and fallback recommender fail; the API/UI returns a loud blocked
  recommendation with no selected execution model.
- User explicitly overrides the recommendation; UI/API metadata records that the
  execution model came from user override rather than from the router engine.

## Coding harness notes

Coding harness routing has two separate decisions:

1. **Path / harness decision**: whether the task is a coding task and whether it
   should use Codex CLI, MiniMax CLI, or another approved coding workflow.
2. **Execution model recommendation**: which authorized model/reasoning pair the
   selected coding harness should run.

The coding harness approval card and `/api/coding-harness/recommend` response
must not present configured router models, fallback router models, or threshold
policy defaults as execution models. Token estimates and large-context signals
may be included in the prompt to the recommender and in diagnostics, but they
must not directly select Codex/MiniMax execution models.

When coding harness recommendation fails:

- show which primary recommender engine failed;
- show whether the paired fallback recommender was configured and attempted;
- if fallback succeeds, show that the fallback recommender selected the execution
  model;
- if fallback fails or is absent, select no execution model and require retry,
  settings changes, or explicit user override.

## Normal chat notes

Normal chat recommendation follows the same model:

- the recommender engine chooses an authorized chat execution model and reasoning
  option;
- the recommender engine itself is not the chat execution model by default;
- the fallback recommender is only a fallback decision engine;
- no hidden third rung, static default, or API-billed substitution may run after
  configured recommender engines fail.

Manual chat selection remains an explicit user-selected execution source. It is
not a router fallback and should be labeled separately from recommender output.

## UI / API labeling requirements

Any UI card, banner, metadata line, or API response that describes routing must
keep these labels distinct:

- **Recommender lane**: `default` or `long-prompt` when lane selection applies.
- **Router/recommender engine**: the model that made the recommendation.
- **Router fallback engine**: the paired fallback model, plus whether it was
  configured, attempted, failed, or used.
- **Execution model**: the model selected to perform the work.
- **Reasoning level**: the reasoning/thinking value selected for execution.
- **Why this model**: the recommender's explanation, or explicit user-override
  reason.

Do not label execution-model fields as “router model”, “default model”, or
“fallback model” unless the source is explicitly a user override or another
non-router execution source. Do not say “deterministic policy selected this
execution model” for normal routing.

## Test requirements for future changes

Routing changes must include targeted tests proving:

- router/recommender engine ids are treated as decision engines, not execution
  defaults;
- fallback recommender ids are treated as fallback decision engines, not
  execution defaults;
- execution model ids come from recommender output, explicit user override, or
  another named non-router source;
- token/length thresholds do not select execution models;
- deterministic lane selection, if present, only chooses the recommender pair;
- primary recommender failure is loud and visible;
- fallback recommender is attempted only after its paired primary fails;
- both-recommenders-failed returns no selected execution model;
- OpenAI API billing is not used unless explicitly enabled by existing settings;
- UI/API labels distinguish recommender lane, recommender engine, fallback
  engine, execution model, reasoning, and reason.

## Implementation Guardrails

Before touching routing, recommender, coding harness recommendation, or router
settings code:

- [ ] Identify whether the change affects path classification, recommender lane
      selection, recommender-engine invocation, fallback behavior, or execution.
- [ ] Verify no deterministic rule directly selects an execution model.
- [ ] Verify router and fallback model ids are used only as recommender engines.
- [ ] Verify authorized execution candidates are passed to the recommender and
      the execution model comes from its result or explicit user override.
- [ ] Verify fallback behavior is paired, visible, and never silent.
- [ ] Verify no hidden default or unrelated provider is tried after configured
      recommender engines fail.
- [ ] Verify API/UI labels expose recommender lane, engine, fallback, execution
      model, reasoning, and reason.
- [ ] Add targeted tests for the semantics above; do not rely on full E2E as the
      only protection.
