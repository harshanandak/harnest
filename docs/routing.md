# Routing V2

Chat-facing settings use `handoff_routing_get`, `handoff_routing_configure` and `handoff_routing_preview`. See [preferences](preferences.md#change-routing-in-chat). Saved `presets` and `activePreset` are user-file containers, expanded before ordinary scope validation. `metadata.routing.preset` selects the user preset for one request and is removed from the request directive before scoring. It does not create another scoring layer or change project/session/request precedence. The decision records the selected preset; preview includes the final custom-resolver result.

Routing V2 chooses one harness/provider/model before a job is persisted. It is deterministic, declarative by default, and explainable in `receipt.routingDecision`.

## Precedence

Policies merge low to high:

1. `routing.global` — machine/global defaults and catalog.
2. User policy — `~/.harnest/routing.json`, `HARNEST_ROUTING_POLICY`, or `routing.userPolicyFile`.
3. `routing.project` (legacy alias: `routing.policy`).
4. `routing.sessions[execution.sessionId]`.
5. Request `metadata.routing`.
6. Optional trusted `HARNEST_ROUTER` / `routing.resolverModule` hook.

A request routes in one of three tiers:

1. **Target only — "name a target, get a route."** A concrete `target` with no `route.model`/`route.provider` is a harness pin. Policy scores and selects the best qualified model WITHIN that target, quickly; the target never changes, and ranked routes (therefore read-only failover) stay inside it. A rule or directive that names another target cannot move it.
2. **Automatic.** Graph node `target: "auto"` (or request `metadata.routing.mode: auto`) selects across all targets: every candidate competes and the winner's target is used.
3. **Explicit route.** `route.provider`/`route.model` fixes the provider, target and model family by default. `modelVersion: pin` also fixes the version; the default is `latest`. Request `metadata.routing.mode: auto` opts into selection; `prefer` keeps the explicit route as a 1,000-point preference.

The machine-local resolver runs last, but cannot replace explicit pins. Explicit thinking survives even when model selection is delegated.

Within each scope, defaults apply first. Matching rules apply in ascending `priority`, then declaration order. Higher scopes override scalar fields; `weights`, `route`, and `require` merge by key; preference arrays are replaced when the higher scope provides them. Candidate IDs merge across scopes. Omitted overlay fields preserve the lower candidate, including `available`, `costUsd`, `latencyMs`, `priority`, tags, capabilities, scores, health, target, and route. An explicit empty tags array clears tags.

## Candidate

```json
{
  "id": "deep-opencode",
  "target": "opencode",
  "route": { "provider": "gateway", "model": "strong-model", "harnessVersion": "v2" },
  "scores": { "quality": 10, "speed": 5, "efficiency": 5, "reliability": 9 },
  "capabilities": {
    "readOnly": true,
    "write": true,
    "taskflow": true,
    "liveControl": true,
    "maxContextTokens": 256000
  },
  "costUsd": 1.5,
  "latencyMs": 5000,
  "health": { "status": "healthy", "headroom": 0.8 },
  "tags": ["deep", "review"],
  "priority": 10
}
```

Scores are bounded to 0–10. `health.status: open` rejects the route until numeric epoch-ms `retryAfter`; `degraded` applies a score penalty. `headroom` is bounded 0–1 and boosts reliability. Policies fail closed on unknown fields, invalid enum values, coercible strings in numeric/boolean fields, negative costs or deadlines, and malformed overlays.

## Rules and prompt intent

```json
{
  "id": "security-depth",
  "priority": 10,
  "when": {
    "taskAny": ["security", "audit"],
    "write": false,
    "hasWorkflow": true,
    "minContextTokens": 10000,
    "metadata": { "risk": "high" }
  },
  "apply": {
    "weights": { "quality": 10, "speed": 1 },
    "require": { "taskflow": true, "liveControl": true },
    "prefer": { "tags": ["deep"] },
    "avoid": { "providers": ["untrusted-gateway"] },
    "maxCostUsd": 2,
    "deadlineMs": 600000
  }
}
```

Supported match facts are bounded: `taskAny`, `taskAll`, target, explicit route provider/model, write policy, workflow presence, session ID, context-token bounds, and exact metadata scalars. There is no request regex, expression language, path lookup, shell, or module import. A lead translates explicit natural-language intent in the prompt into request `metadata.routing`; direct prompt keywords may also match configured rules.

Provider/model matches can propose legacy-route replacements when the request explicitly opts into automatic selection; pinned requests retain their original route:

```json
{
  "id": "muse-contributor",
  "priority": -100,
  "when": { "target": "pi", "provider": "opencode", "model": "muse-spark-1.3" },
  "apply": { "route": { "provider": "opencode-go", "model": "muse-spark-1.3-contributor" } }
}
```

## Selection

Candidates are rejected before scoring for: unavailable/open circuit; target mismatch (against a directive target or the request's own target pin); write/read-only incompatibility; Taskflow/live-control requirement; context capacity; budget; deadline; provider requirement; and avoid lists.

Survivors score as:

```text
quality*Wq + speed*Ws + efficiency*We + reliability*Wr
+ preference bonuses + harness-order bonus + health headroom - degraded penalty
```

Each axis is composed before weighting. Candidates may state model capability
(`model: {intelligence, taste, speed, costEff}`, 0-10, costEff = cost-efficiency
so more is better throughout) and harness loop characteristics
(`harness: {speedMod, efficiencyMod}`, -5..+5) separately:

```text
quality    = 0.7*intelligence + 0.3*taste   (or flat scores.quality)
speed      = clamp(model.speed + speedMod)   (or flat scores.speed)
efficiency = clamp(0.6*costEff + 0.4*decisiveness + efficiencyMod)
             (costEff alone when decisiveness is absent; flat when no block)
reliability = flat scores.reliability        (always; trust is historical)
```

`decisiveness` (0-10, finishes in few turns) matters because turns multiply
BOTH wall-clock and tokens: cheap-per-token means little at 4x the turns.
Candidates without a `model` block keep legacy flat scores verbatim, so
existing policies score identically. Thinking levels gate separately (below),
never through scores.

Rationale: a cheap-but-capable model (grok-class) wins on cost-efficiency plus
intelligence without pretending the harness loop is free — Pi's fast loop adds
speed, a cold OpenCode hop subtracts it. Candidates without a `model` block
keep legacy flat scores verbatim, so existing policies score identically.

The harness-order bonus is `(positions below + 1) × 20`, plus 1 for first place —
so your #1 choice edges out even an explicit `prefer` (+100) while deeper slots
yield to one, and explicit route pins (+1000) still top everything. The applied
bonus and the effective order/tier are echoed in the decision as `orderBonus`,
`harnessOrder`, and `tier`.

Ties use candidate `priority`, then lexical candidate ID. Explanations contain scope/rule/candidate IDs and numeric/reason codes only; task/context text and credentials are excluded.

## Model freshness

`modelVersion` follows ordinary policy precedence and accepts `latest` (default) or `pin`. In latest mode, the shared runtime consults the selected harness's metadata catalog and chooses a newer version with the same family/tier and provider. Endpoint and effort suffixes are preserved. This covers future numbered releases without editing a latest-version table. Claude's documented latest aliases resolve natively. In pin mode, an exact model ID is required, discovery is skipped and the version remains unchanged.

The catalog service caches by harness, provider and working directory, refreshes on demand after expiry, and marks failed/stale discovery. Preview and execution use the same selection code; the decision's `modelFreshness` records mode, requested/resolved model, source and status. Failed or ambiguous discovery retains the requested model with an unverified-latest warning. It never fabricates a newer ID or downgrades to an older release.

`npm run check:models` remains an advisory comparison against the legacy snapshot in `src/model-families.mjs`. Runtime version selection does not depend on that snapshot or a manual refresh command.

## Resolver stability

The optional trusted resolver has separate import and call deadlines (`routing.resolverTimeoutMs`, default 5s). Three consecutive failures open its circuit for 30s by default; configure `routing.circuitBreaker`. `resolverFailureMode: closed` rejects the handoff. `passthrough` preserves the declarative route and records resolver status in the decision.

Executable resolver modules are loaded once per MCP process. The resolver diagnostic reports `not-loaded`, `current`, `stale`, or `unknown` by comparing the loaded-source fingerprint with the current file; `stale` means the module changed after load and the MCP process must restart before that policy takes effect. The diagnostic returns fingerprints and timestamps only, never resolver source or request content.

The user JSON policy is checked for content changes. Sugar expansion and full policy/candidate validation must pass before it becomes last-known-good. If a previously valid policy becomes invalid, the last-known-good policy stays active and the decision reports a warning. An invalid first load fails closed. Doctor uses the same expansion and routing engine rather than blessing JSON syntax alone.

Codex alone currently supplies a native zero-inference quota snapshot through `account/rateLimits/read`. The Codex adapter uses it for pre-launch warnings and successful-receipt evidence. `scripts/detect-allowance.mjs` reports the same snapshot read-only and keeps login state separate. It does not write routing policy, so `scripts/set-pressure.mjs` remains the explicit manual source for candidate health. Cursor, Pi, Claude, and generic OpenCode account quota stay unknown; local session usage, authentication success, model catalogs, and billing balances are not treated as headroom.

## Deliberate limits

Routing reads native model metadata without inference. Catalog visibility does not prove quota or job-time availability. The Codex adapter's native quota snapshot is observable pre-launch evidence, but automatic route scoring still changes only through explicit candidate health or the trusted resolver. Routing does not persist circuit state across MCP process restarts, run untrusted policy code, or create cross-harness workflow phases.

Ordered failover is intentionally narrow: after launch, a **read-only** run whose adapter fails with `transport` (harness missing/unreachable), wall-clock `timeout`, an explicit provider failure (`provider-auth` for rejected or missing provider authorization/billing/region opt-in, `unavailable` for a missing catalog or private-server model), or task-level `downstream`/`completion-contract` failure ("stuck here, try the next harness") retries once on the next viable ranked route (`rankedRoutes` in `routingDecision`). A pinned target keeps `rankedRoutes` — and therefore failover — inside that harness. The switch is recorded in `receipt.routingFallbacks` (with the original `errorKind`) and the trace. Read-only retries cannot mutate anything — the only cost is tokens, capped at one retry. Write-capable runs never fail over (a retry could duplicate side effects), nor do cancellations, policy/validation rejections, budget exhaustion, or persistence loss. Opt out per request with `metadata.routing.fallbacks: false`. Each attempt gets a fresh full `execution.timeoutMs`; the failed run's `execution.sessionId` is never carried across targets.
