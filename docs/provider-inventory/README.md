# Free Coding Provider Inventory

This folder tracks free, no-auth, free-tier, and trial-credit LLM providers that may be worth adding to OmniRoute for coding-agent work.

The inventory is intentionally focused on providers/models useful for:

- coding agents
- debugging
- repo edits
- tests
- terminal work
- code review

It is **not** a general AI-provider catalog. Search, image, video, audio, embedding, and paid-only providers should stay out unless they materially help coding workflows.

## Files

- `free-coding-provider-candidates.csv` — ranked provider inventory and next actions.

## Ranking formula

Rows are sorted by:

```text
setup_value_eur_per_hour = expected_6mo_value_eur / (setup_time_minutes_est / 60)
```

Where:

- `expected_6mo_value_eur` is an avoided-cost / practical-utility estimate for the user's coding workflow over the next six months.
- `setup_time_minutes_est` estimates the time to sign up, create a key, add it to OmniRoute, import models, and run smoke tests.

Tie-breakers:

1. lower signup friction first
2. no credit card before unknown/required credit card
3. OpenAI-compatible before custom/native APIs
4. stronger coding models before generic chat models
5. lower region friction first

## Status values

- `already_working` — already connected/usable or previously smoke-tested successfully through OmniRoute.
- `candidate` — worth adding next, but not yet connected or smoke-tested.
- `signup_needed` — provider looks useful but requires account/API-key setup before testing.
- `needs_verification` — value looks promising, but free limits/model IDs/current behavior are uncertain.
- `flaky` — works inconsistently, rate-limits, or has conflicting test signals.
- `rejected_for_now` — not worth adding now because it failed, is not coding-useful, or lacks a clear free offering.

## Updating `last_researched`

Use ISO date format:

```text
YYYY-MM-DD
```

Update `last_researched` whenever you verify one of these:

- free-tier availability
- credit-card requirement
- phone/region requirement
- model list
- base URL/API style
- OmniRoute support status
- smoke-test result

## Smoke test rule

Never trust catalog listings alone. A model is usable only after an actual chat completion succeeds.

Suggested smoke test:

```bash
opencode-omniroute run "What is 2+2? Reply with only the number." --model <model_id>
```

Equivalent direct OmniRoute API test:

```bash
curl -sS "$OMNIROUTE_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model_id>",
    "messages": [{"role":"user","content":"What is 2+2? Reply with only the number."}],
    "max_tokens": 20
  }'
```

A passing smoke test should record:

- provider
- exact model ID
- HTTP status
- short response
- latency
- whether the request used paid quota or free/free-tier quota
- date tested

## Secret handling rules

Never commit API keys, tokens, cookies, session values, or screenshots showing secrets.

Provider keys should be added only to OmniRoute, not directly to random app configs.

Local harnesses should use the shared OmniRoute gateway credential instead of individual upstream provider keys. For example:

```text
OMNIROUTE_BASE_URL=http://127.0.0.1:20128/v1
OMNIROUTE_API_KEY=<local gateway key>
```

If a harness only supports OpenAI-compatible environment variables, point those variables at OmniRoute, not at OpenAI directly.

## Provider setup rule

For OmniRoute provider setup:

1. Do not sign up unless the CSV row's `next_action` says to.
2. Do not add a credit card unless explicitly approved.
3. Prefer provider pages that support "Import only free models".
4. For the OmniRoute `Validation Model` field, leave it blank first.
5. Only if validation fails, use a concrete small/free model ID.
6. After saving, import models.
7. Run smoke tests with tiny prompts.
8. Add only passing model IDs to Control Room/OpenCode allowlists.

## Interpreting OmniRoute support

- `built_in_working` — OmniRoute already routes this successfully.
- `built_in_needs_exact_model_smoke` — visible in OmniRoute but needs exact model test.
- `connected_needs_periodic_smoke` — key is connected, but models should be re-tested periodically.
- `provider_present_signup_needed` — provider exists in OmniRoute, but needs an account/API key.
- `built_in_flaky` — no-auth provider exists but is rate-limited or inconsistent.
- `built_in_failing` — provider exists but recent test failed.
- `not_prioritized` — not a current free-first target.

## Update workflow

1. Research official provider docs.
2. Update the CSV row.
3. Add/adjust `source_urls`.
4. Add the provider key to OmniRoute only.
5. Smoke test exact model IDs.
6. Move successful model IDs into the Control Room/OpenCode allowlist.
7. Keep failed/catalog-only models hidden or marked as `rejected_for_now`.
