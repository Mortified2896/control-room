# Mac Codex lean telemetry audit findings

_Snapshot audited: 2026-08-19. The active archive continued to receive records while the
audit was being developed; counts below are from one completed read-only pass._

## Executive answer

The current lean archive is already useful for meaningful task, actual-model, tool, token,
runtime, and failure analysis without MLflow or another analytics service. It is not yet a
complete provenance dataset. Requested model is absent, metrics have no usable trace or
conversation correlation, parent resolution is 95.28%, and repository/project identity is not
recorded directly.

We can distinguish four privacy-safe working-directory contexts in this snapshot. Direct `cwd`
evidence occurs on 373 of 376 identified turns, and trace linkage associates one and only one of
those contexts with 203 of 260 conversations. That supports workspace-level comparison for most
turns. It does **not** prove which Git repository, Git remote, ChatGPT project, or Codex project a
task came from.

## Data inspected

The audit streamed all ten newline-delimited OTLP JSON files then present under
`data/lean/{logs,traces,metrics}`. It did not read the forensic or legacy tiers.

| Signal    |  Files | Export requests |              Items |           Bytes |
| --------- | -----: | --------------: | -----------------: | --------------: |
| Logs      |      4 |           3,447 | 67,173 log records |      66,473,822 |
| Traces    |      4 |           6,806 |      153,179 spans |      63,476,501 |
| Metrics   |      2 |             642 | 38,566 data points |      28,673,744 |
| **Total** | **10** |      **10,895** |        **258,918** | **158,624,067** |

No malformed records or unreadable files were observed in this pass. The command reports both
conditions explicitly when they occur, including the relative filename and line number but not
the rejected content.

## Verified

### Identity and correlation

- The archive contains 260 unique conversation IDs, 259 session/thread IDs, 376 turn IDs,
  30,226 trace IDs, and 153,179 unique span IDs. No duplicate span records were found.
- Conversation IDs occur on about 97.8% of log records but only 3.1% of spans and no metric
  points. Of 260 unique conversation IDs, 247 (95.0%) occur in both logs and traces.
- Session and turn IDs occur only in traces. They therefore identify trace-side sessions and
  turns but cannot directly correlate logs or metrics.
- Logs carry trace IDs: 1,790 of 1,798 unique log trace IDs (99.56%) match a retained trace.
- Metrics have no trace IDs, exemplars with trace IDs, conversation IDs, session IDs, or turn IDs
  in this snapshot. Existing metrics therefore cannot be assigned reliably to a task.

### Parent and runtime integrity

- All 153,179 spans have calculable start/end duration.
- Of 123,393 spans with a parent ID, 117,563 parents are present in the lean archive. There are
  5,830 unresolved parent references, for 95.28% parent resolution.
- The audit cannot determine from the lean tier alone whether each missing parent fell outside
  the retained time window, was removed by filtering, or was never emitted.

### Analytical fields

Completeness below uses all items in each signal as the denominator. Low percentages are often
expected for event-specific metadata, so the audit also reports the event keys and raw counts.

| Field                   |  Logs | Traces | Metrics | Finding                                                    |
| ----------------------- | ----: | -----: | ------: | ---------------------------------------------------------- |
| Actual model            | 97.8% |   7.1% |   69.0% | Four safe categorical values observed                      |
| Requested model         |    0% |     0% |      0% | Not observed                                               |
| Provider                |  0.4% |   0.9% |      0% | One provider value; event-specific                         |
| Reasoning effort        |  2.0% |   3.9% |      0% | Four values; event-specific                                |
| Token usage             |  2.0% |   0.9% |    5.0% | Present in log/span attributes and token-usage metrics     |
| Duration                | 97.5% |   100% |   39.6% | Direct log duration, span timestamps, and duration metrics |
| Error metadata          |    0% |  0.25% |      0% | Trace attributes/events only                               |
| Status metadata         |  2.7% |   1.4% |   30.1% | Event-specific; no OTLP span status object observed        |
| Sandbox/permission      |  1.4% |   0.1% |    4.8% | Policy and decision values are available intermittently    |
| Service version         |  100% |   100% |    100% | Consistent                                                 |
| Capture source identity |  100% |   100% |    100% | Consistent                                                 |

The four actual-model values were `codex-auto-review`, `gpt-5.6-luna`, `gpt-5.6-sol`, and
`gpt-5.6-terra`; the sole provider value was `OpenAI`. Reasoning values were `low`, `medium`,
`high`, and `xhigh`. These are item-occurrence values, not task-level distributions.

Tool identity occurs on 5,450 items with 44 distinct hashed identities. An outcome co-occurs on
3,101 of those items (56.9%); 3,044 explicitly report success and 54 explicitly report failure.
The audit does not print tool names because dynamic MCP or connector names may be sensitive.

### Repository, workspace, and project attribution

- `cwd` is the only attribution field observed: 1,079 trace items (0.7% of spans).
- No repository name/root, Git remote, Git branch, Git repository identifier, ChatGPT project,
  Codex project, or project-to-conversation field was observed in resource, scope, span, log, or
  metric attributes.
- The audit hashes `cwd` values before grouping and never emits raw paths. Four distinct hashed
  working-directory contexts were present.
- `cwd` directly co-occurs with 373 of 376 turn IDs (99.2%). Through shared trace IDs, exactly one
  context can be inferred for 203 conversations, 197 sessions, and 373 turns; no identity maps to
  multiple contexts in this snapshot.

### Privacy

- All 376 observed `prompt` values are the expected `[REDACTED]` marker. No non-redaction prompt
  value was observed.
- Tool arguments, tool output, email, and account ID keys were not observed by the audit.
- The structural key `error.message` occurs on 168 trace items/events. The audit counts the key
  but never renders its values. This is a privacy gap worth reviewing in the trace filtering
  pipeline; it does not justify enabling or retaining more payload content.
- The audit emits only schema keys, aggregates, approved categorical metadata, and hashed context
  cardinalities. It never emits raw paths, identifiers, prompt text, tool names/arguments/output,
  account identifiers, error messages, or arbitrary attribute values.

## Inference

- Conversation identity is reliable for logs and can usually be connected to traces through the
  shared conversation ID or trace ID.
- Turn identity is reliable inside traces and workspace attribution is strong for turns, because
  99.2% of turn IDs have direct `cwd` evidence. Conversation-to-workspace attribution is weaker
  and depends on trace linkage rather than a direct conversation attribute.
- The four hashed `cwd` values probably represent four workspaces and may represent separate Git
  repositories. The telemetry does not establish that they are Git repositories, and two paths
  could theoretically refer to the same repository or project.
- Event-specific model, reasoning, token, tool, duration, permission, and error metadata is rich
  enough to begin exploratory analysis if denominators are chosen by event/span type rather than
  across all telemetry items.

## Missing / unknown

- Requested model, and therefore requested-versus-actual model/fallback analysis.
- Direct Git repository/root/remote/branch identity.
- Direct ChatGPT or Codex project identity and project-to-conversation relation.
- Task-level correlation for metrics.
- Log/metric correlation by session or turn ID.
- Cause of each unresolved parent reference.
- Complete tool outcome coverage; 43.1% of tool-identified items lack a co-located outcome.

## Recommendation

Begin analysis now using the lean files and this audit's structured JSON. Scope initial work to
actual model, conversation/trace-linked turns, tool activity, token events, durations, explicit
failures, and the four hashed workspace contexts. Do not treat requested model, Git repository,
ChatGPT/Codex project, or metric-to-task attribution as known.

The smallest high-value instrumentation change is one privacy-safe, stable workspace identifier
attached at the task/session boundary and propagated to logs, traces, and metrics. Derive it from
the canonical workspace or repository root using a node-local keyed hash; do not record the raw
path or remote. If the app has a native ChatGPT/Codex project relation, add a separate opaque,
similarly hashed project identifier rather than conflating it with the workspace. Propagating the
existing conversation and turn identifiers to metric points would then close the largest
cross-signal gap. These are instrumentation recommendations only; this task does not change Codex
or assert unsupported configuration fields.

Separately, inspect why `error.message` remains in lean trace events and decide whether the
existing trace privacy processor should remove it. Keep `log_user_prompt=false` unchanged.
