# Preferences, order, and model selection

## Simple setup (start here)

### Change routing in chat

Ask your lead to **show routing**, **save a review preset**, **use a saved preset**, or **explain which model would handle a task**. The same controls are available in every connected MCP client, including Claude Code, Codex, OpenCode, Pi, Cursor, Gemini CLI, and Amp:

1. `handoff_routing_get` shows the active preset, base settings, named presets and revision.
2. `handoff_routing_configure` edits the user file with that `expectedRevision`. A stale revision rejects the edit rather than losing someone else's changes.
3. `handoff_routing_preview` resolves a representative request through the actual selector and configured custom resolver. It creates no handoff. Check the final target, provider, model, thinking and override warnings.

The canonical file remains `~/.harnest/routing.json` (or the configured user-policy path). Existing rules and candidate ratings stay intact. A small file can look like this; the model is illustrative and must be replaced with an available catalog entry:

```json
{
  "tier": "balanced",
  "models": { "pi": "provider/model-id" },
  "presets": {
    "review": { "tier": "review", "thinking": "high", "fallbacks": false },
    "quick-work": { "tier": "quick" }
  },
  "activePreset": "review"
}
```

Presets overlay base preferences; per-harness model maps merge. Clear the active preset with `use-preset` and `preset: null` to restore base preferences. Select a preset for just one request with `metadata.routing.preset`; `null` selects base for that request. Explicit request models and thinking keep their existing precedence. A running handoff retains its resolved route.

The configure actions are `set` (patch base preferences), `save-preset` (create/replace), `use-preset`, and `delete-preset` (inactive presets only). Base patches accept null to remove a preference or one model override. Advanced project/session rules and trusted resolver hooks may override these user preferences; preview makes that visible. A preset named `free` is a name, not a cost restriction: select verified free endpoints explicitly when that restriction matters.

Saved user preferences reload on the next routing decision in the same process. Preview evaluates a saved-policy snapshot and reports its revision and configuration hash. It has an independent circuit breaker, so it may differ from a running resolver with an open circuit. Invalid saved files make preview fail; execution may retain a last-known-good policy with a warning. Host configuration and executable resolver modules are process-cached and require a restart to pick up edits.

### Latest or pin

`modelVersion` has two values:

- `latest` (default): follow the newest verified release in the chosen family and tier. A Sol 5.6 preference can advance to Sol 6, without editing a version table.
- `pin`: keep the exact model version you chose until you change it. Supply a concrete model ID; aliases such as `sonnet`, `sol`, or `auto` cannot be pinned.

Set this in base preferences or a saved preset through `handoff_routing_configure`. For one handoff, use `metadata.routing.modelVersion`. Model names remain in the existing `models` map. This works through the shared core for all connected hosts.

Latest selection uses native metadata catalogs, refreshed on demand after the one-hour cache expires. Claude's documented latest aliases resolve in Claude itself. A failed refresh keeps the requested model and reports that latest is unverified. Provider, family, tier and endpoint suffixes stay fixed; upgrades must support the requested thinking level. Free endpoints require zero-price catalog evidence before upgrading. Preview reports the requested and resolved model, mode, source and freshness status.

### Set up from the terminal

You do not need to learn the full policy engine. Three knobs cover nearly
everyone — run the one-minute wizard or write them by hand:

```powershell
node scripts/setup-routing.mjs
```

```json
{
  "harnessOrder": ["pi", "claude", "codex", "opencode", "cursor", "gemini", "amp"],
  "tier": "balanced",
  "models": {
    "claude": "sonnet",
    "cursor": "composer-2.5",
    "codex": "gpt-6.2-sol"
  }
}
```

- **`harnessOrder`** — your preferred harness ranking, strongest first. It acts
  as a gentle default bonus (first choice earns most), so an explicit request
  route, `prefer` rule, or capability requirement still overrules it. It also
  sets the read-only failover sequence: transport/timeout retries walk this
  order. Unknown names never match, so typos fail safe to score order.
- **`tier`** — task intent in one word: `quick` (fast/cheap lanes),
  `balanced` (default weights), `deep` (quality-first), `review`
  (second-opinion depth). Tiers never name a harness or model, so they keep
  working as your subscriptions, limits, and model catalogs change. Explicit
  `weights`/`prefer` in the same scope always override the tier-implied values.
- **`difficulty`** — the work, not the intent: `trivial` (stay cheap even when
  the order prefers flagships), `bounded` (default, no effect), `hard` (earn
  depth). Travels per request in `metadata.routing.difficulty` and matches in
  rules (`when: { difficulty }`). The wizard's starter rules wire
  trivial→cheap lanes and hard→depth automatically.
- **`models`** — default model per harness. Only what you set is used:
  Automatic selection includes OpenCode, Codex, Cursor, and Gemini only
  when configured with a model. Pi and Claude can use native defaults. A
  direct Codex request without a model can also use the native default.
  The example's Codex entry is a per-harness pin for a coding lane. For
  individual tasks, use the [leaf defaults](#model-defaults-for-leaf-tasks)
  unless the caller supplies a pin. Use `route.variant` for Amp's native
  thread mode. DeepSeek models run through Pi or OpenCode provider routes.

Generic ACP registrations are explicit only: `target: "acp"` must carry
`route.agent`, and the built-in wizard/automatic candidate set never selects an
unconfigured registration. A registration may declare ACP protocol major 1 or
2; its registry package version never supplies that value. Generic ACP does not
accept a model default in `models`.

Why no dollar costs here? Everything in this setup runs on subscriptions
(Cursor, Claude, OpenCode Go seats) where marginal cost is $0 — so there
is deliberately NO budget enforcement path in the wizard or the generated
lanes. `maxCostUsd` budgets and `costUsd` candidate prices exist only for API
billing; on subs, skip them entirely. Relative efficiency still steers
selection through `costEff` ratings (a lean model wins `quick` lanes without
anyone counting dollars).

## Subscription pressure (the sub-aware efficiency dial)

Dollars are fiction on subs — plan tiers ($10/$20/$100/$200) and their
allowances are what actually differ. Two dials, kept separate because they
answer different questions:

- **Subsidy** — how much of the cost your plan absorbs (`subscriptions` map:
  `{ cursor: { plan: "pro-20", subsidy: 1 } }`, written by `setup-routing`).
  It pulls a lane's cost-efficiency toward free: 1 = fully covered (even a
  pricey model scores max efficiency), 0 = API reality (sticker prices rule,
  the default when you record nothing). Partial values cover overage-style
  plans. Per-candidate `subsidy` overrides the map.
- **Pressure** — remaining allowance *right now* (`scripts/set-pressure.mjs
  --pressure cursor=0.3`). Exhausted halves efficiency, fresh keeps it whole,
  unrecorded stays neutral. Read-only probes (`scripts/detect-allowance.mjs`)
  report authentication readiness, not quota. `--apply` has no quota signal
  to write; record remaining allowance manually. Existing auto-stamped values
  are preserved until you replace them with a manual measurement. Subsidy suggestions from detection
  are print-only — billing assumptions are never written automatically.

Setup and pressure updates share a transaction lock, preserving other writers'
candidate overlays. A timed-out lock reports its path; remove it only after
confirming the previous writer has stopped. Setup persists the training answer;
non-interactive equivalents are `--allow-training-endpoints` and
`--no-training-endpoints`.

Subsidy is slow-moving (set once per plan change); pressure is live (refresh
whenever a sub feels hot). Together they replace dollar budgets entirely on
subs — and when both say "covered and fresh," selection falls through to
capability, which is exactly right.

Selection order matters more than scores: capability filters run FIRST (a route
that cannot do the job has no price), weights arbitrate LAST among survivors.
Order names must be installed harnesses — `doctor` marks each ordered harness
✓/✗ so a typo or missing install shows up immediately. And the hop rule of
thumb: if the brief does not fit in one self-contained prompt, do not hand off
— re-stating context across the hop costs more than it saves.

Per request, the same knobs travel in `metadata.routing` (`tier`,
`harnessOrder`, `difficulty`, `mode: auto|prefer`) or match in rules (`when: { tier }`,
`when: { difficulty }`). `doctor` prints the effective order (`routing-order:` line)
and pin freshness (`models:` line).

## Harness topology: what earns a lane

Pi is the default home for anything portable — any provider model (including
DeepSeek and Codex-CLI-reachable work through its tools), taskflow graphs,
live steering, fastest effective loop. Route elsewhere only for what Pi lacks:

- **claude:** Claude models — nothing else runs them. Plus real budget
  enforcement (`--max-budget-usd`) and the cheapest resume. Taste-critical UI
  work routes here for a second-opinion review lane; so does anything stuck
  on another harness (read-only downstream failure fails over to the next
  ranked route automatically).
- **codex:** Codex CLI (`codex exec`) — scriptable one-shot with JSONL
  events, `-m` model flag, `--sandbox` mapping, and `exec resume` follow-ups.
  Choose the model and effort by task. The optional browser-task starter rule
  prefers Codex, but verified computer-use capability is unavailable on the
  one-shot CLI routes.
- **opencode:** OpenCode Go high-limit catalogs and v2 live control. Note the
  auto lane assumes the v1 path (no live control); pin `route.harnessVersion`
  `v2` with `capabilities.liveControl` for steerable runs.
- **cursor:** NAMED cheap models only (`cursor-cheap` grok lane,
  `cursor-flagship`, …). The bare Cursor default earns no auto lane — without
  a name it adds nothing over Pi. Inside Cursor with a subscription, Composer
  Standard is cheapest-in-class (marginal ~$0); Fast at 6× is never the default.
- **gemini:** prompt-only attached Gemini CLI execution. Named models are
  accepted only when the adapter can pin them; mode names are not treated as
  arbitrary model IDs. Live controls and session transport are unsupported.
- **amp:** prompt-only attached write execution on native Linux/macOS or with the entire
  Harnest MCP server running inside WSL. Read-only is unsupported because
  workspace settings/plugins prevent a trustworthy native boundary. Only
  `route.variant` `low`/`medium`/`high`/`ultra` is accepted; arbitrary model,
  provider and thinking fields reject before inference. When resuming with
  `execution.sessionId`, omit `route.variant`: the native thread retains its
  existing mode, and a conflicting mode request rejects before launch.
- **dsh:** not a downstream target. DSH one-shot headless has no subagent
  edge over Pi running the same DeepSeek model, so protocol rejects
  `target: "dsh"` outright with a redirect to Pi/OpenCode provider routes.
  A DSH *lead* integration stays possible in principle, impossible in rc.7
  (headless accepts only task text, no MCP surface).

`require.computerUse` honestly rejects every auto lane: no one-shot CLI route
in this set offers usable computer-use (Claude-in-Chrome needs a visible
window, Cursor browser is IDE-bound, the rest have no browser tool).

## Model capability vs harness capability

Price alone cannot route once a cheap model is also capable (grok-class on
Cursor). So the engine scores the two separately and composes them:

- **Model** (`model: {intelligence, taste, speed, costEff}`) — what the model
  is: reasoning, taste, raw speed, cost-efficiency (10 = cheapest). Family
  defaults (`grok`, `composer`, `sol`, `terra`, `sonnet/opus/claude`, `deepseek`)
  ship in the catalog as documented estimates so you rate a lane once per
  family, not once per versioned id.
- **Harness loop** (`harness: {speedMod, efficiencyMod}`) — what the harness
  costs every run regardless of model: Pi's loop is fast and lean (+2/+1), a
  cold OpenCode hop pays startup and re-stated context (-2/-1), Cursor pays
  spawn/hang tax (+0/-1), Claude is near-native (+1/+0), Codex sits native
  without shim tax (+1/+0, provisional). Estimates from local spawn timings,
  verified 2026-09-11.
- **Harness features** (`capabilities.computerUse`, plus `taskflow`,
  `liveControl`) — hard gates via `require`, never vibes. When two lanes tie
  on model capability, the harness with the right features and the faster loop
  wins on the numbers, not on narrative.

`setup-routing` offers explicit cheap + flagship Cursor lanes from the live
model list so one harness fields both ends honestly. Full formula: `docs/routing.md`.

## Thinking levels: effort is a gate, not a vibe

`route.thinking` names the reasoning effort for the run. Level names are
harness-specific and never translated — each adapter passes the value through
verbatim, or documents why it cannot:

| Target | Thinking support |
|---|---|
| Pi | `--thinking` verbatim (levels CLI-verified) |
| OpenCode | used as variant verbatim |
| Codex | `-c model_reasoning_effort="<level>"` verbatim |
| Cursor, Claude | recorded in the receipt; CLI passthrough unverified, so no flag is sent today |
| Gemini, Amp | no generic thinking mapping is advertised; unsupported values reject before inference (Amp uses `route.variant` instead) |

Set `route.thinking` to `high` when preparing a new Codex leaf route. The
following rules apply when reasoning effort is omitted or a route declares
supported levels.

1. **Derived default when unnamed.** Tier and difficulty each imply a level
   (`quick`/`trivial`→`low`, `balanced`/`bounded`→`medium`,
   `deep`/`review`/`hard`→`high`); the higher wins, capped at `high`.
   Defaults never exceed high — `xhigh`/`max` must be an explicit ask.
   The receipt records `thinking` plus `thinkingSource`: `explicit`, `policy`, or
   `tier/difficulty default`.
2. **Hard gate on declared support.** Candidates may declare
   `capabilities.thinking: [...]` (Pi's list is CLI-verified; others use
   unvalidated passthrough until confirmed). A named level the lane does not
   declare rejects with `thinking-level` — the wrong effort ruins the run
   regardless of model. Undeclared lists accept anything.

## Multi-model review loop

`handoff_review` scores work with 2-8 read-only lanes and converges opinion —
it never writes code. Round 1 scores independently against your rubric;
rounds 2-3 share every lane's findings and scores plus directed lane-to-lane
messages (`"to": [{"lane": ..., "message": ...}]`), then re-score. Each lane
must close with the fenced JSON score block covering every factor or it
abstains; fewer than 2 voting lanes fails the review. Average reaches
threshold (default 9/10) → `completed`; rounds exhaust below it → `partial`
with consolidated, deduplicated, lane-attributed findings. You implement,
then re-invoke with `previous: { summary, scores }` — the next loop confirms
what was fixed and scores the current state only. Reviewer routes must
resolve distinctly (same-model-twice is rejected); lanes are read-only and
capped at 3 rounds, one fallback-free run each.

## Model defaults for leaf tasks

Use these defaults when choosing a new Codex route.

| Task | Model | `route.thinking` |
|---|---|---|
| Write code | `gpt-6.2-sol` | `high` |
| Review code or investigate a problem | `gpt-6.1-sol` | `high` |
| Read-only non-code research, lookups, or audits | `gpt-6.1-terra` | `high` |

An explicit caller pin takes precedence. Use `metadata.routing.modelVersion`
`pin` for the exact version. The native Codex worker bridges
use `gpt-6.1-terra` at high effort to forward requests. Their downstream
agents follow the routes selected by the lead. User-configured automatic
routes still use the existing rules and candidate catalog. For other
providers, verify the available model IDs before dispatch.

## Model freshness

Use [latest or pin](#latest-or-pin) to choose whether a model follows new releases or stays fixed. Latest selection refreshes native catalog metadata automatically. Omitting the model leaves selection to the harness default; that is not proof of the newest release in a particular family. Cursor `auto` is a selector, not an exact version.

`node scripts/refresh-models.mjs` remains a separate diagnostic snapshot for `doctor`. It is not required to update latest-mode routes.

Worth-the-limits logic is difficulty-gated, not price-gated: trivial tasks
stay on cheap lanes, hard tasks earn flagships, and subscriptions (marginal
$0) versus API billing never enter the formula as invented dollars.

## Per-family routing notes (community evidence, Sep 2026)

Benchmarks say what a model *can* do; user reports say what it *does* in a
delegation loop. Patterns, not viral posts:

- **Grok (Cursor lanes):** fast executor, not final judge. Harness-sensitive
  (-9pts on neutral harnesses), over-codes and overcomplicates without tight
  scope; needs small focused tasks, acceptance canaries, and a flagship
  reviewer. Never solo for architecture, taste-critical copy, or legacy spelunking.
- **Composer (Cursor lanes):** best default inside Cursor for routine work —
  but **Fast costs 6× Standard and is the default**, the #1 bill shock. Route
  Standard unless latency is truly critical; set dashboard spend caps.
  Escalate cursed bugs and architecture to Opus/Fable/GPT.
- **GPT/Codex lanes:** long-horizon and async-review kings; brittle tool
  plumbing (spurious calls, infinite retry loops, low-verbosity narrator
  halts). Demand file:line receipts and verify programmatically. `high`
  effort, not `xhigh`, unless security/architecture.
- **Claude lanes:** quality/taste ceiling and best-studied subagents — but
  burn dominates complaints. Documented failure cluster (fabricated
  completion with zero tool calls, silent hangs, scope expansion) is why
  workers must return receipts verbatim and never paraphrase machine fields.
- **DeepSeek lanes:** best-value open worker; verbose receipts need the
  strict format envelope (already the handoff contract). Flash frequently
  beats Pro on agent tasks — Flash default stands. Re-evaluate after
  post-train pushes; independent numbers are thinner than vendor ones.
- **Spark (Meta Muse Spark, OpenCode Go contributor channel):** plan/code
  review specialist, AA-leading intelligence, fast, somewhat verbose, effectively
  $0 — but prompts/completions may train Meta models, so never route private,
  customer, or unreleased work to `*-contributor` endpoints. Thinking caps at
  `xhigh` (Pi level map has no `max` for spark).
- **Gemini Flash lanes:** fast cheap throughput for well-architected scoped
  tasks, not an architect. Promo pricing doubles on expiry — re-check before
  trusting old cost ratings.

This is the operator-facing companion to `routing.md`. It explains how Harnest
decides which harness/provider/model runs a handoff, in what order, and how to express
intent without touching code.

## Precedence (lowest to highest authority)

1. `routing.global` — machine catalog: candidates, default weights, global rules.
2. User policy — `~/.harnest/routing.json`, `HARNEST_ROUTING_POLICY`,
   or `routing.userPolicyFile`. Hot-reloaded; last-known-good wins on invalid edits.
3. `routing.project` (alias: `routing.policy`) — repo-local defaults from local config.
4. `routing.sessions[execution.sessionId]` — per-session overrides.
5. Request `metadata.routing` — per-handoff declarative intent.
6. Trusted resolver (`HARNEST_ROUTER` / `routing.resolverModule`) — machine-local
   facts only (live headroom, auth state, private benchmarks). Request content can never
   nominate executable code.

Higher scopes override scalars, merge `weights`/`route`/`require` by key, and replace
`prefer`/`avoid` arrays when present. Candidate IDs merge across scopes; omitted overlay
fields preserve the lower scope.

## Explicit route vs policy selection

- An explicit `route.provider`/`route.model` fixes the route by default: policy scores nothing. Set `modelVersion: "pin"` to keep its exact version; `latest` follows new releases within that family/tier.
- `metadata.routing.mode: "auto"` opts into full policy selection.
- `metadata.routing.mode: "prefer"` keeps the explicit route as a 1,000-point preference:
  it wins unless a rule (budget, capability, avoid-list) rejects it.

Rule of thumb for leads: pass an explicit route when the user named a model; pass
`mode: auto` when the user said "pick the best/fastest/cheapest"; pass `mode: prefer`
when the user said "prefer X but fall back if it cannot do the job".
For "keep this exact version," also set `metadata.routing.modelVersion: "pin"`.

## Order: how candidates rank

Rejection runs before scoring (capability-first). A candidate is rejected for:
unavailable/open circuit, target mismatch, write/read-only incompatibility,
Taskflow or live-control requirement, context capacity, budget, deadline, provider
requirement, or avoid-list match.

Survivors score:

```text
quality*Wq + speed*Ws + efficiency*We + reliability*Wr
+ 100 for prefer-list match
+ 1000 for explicit-route match in prefer mode
- 50 when degraded
+ headroom * reliability-weight * 10
```

Ties break on candidate `priority`, then lexical candidate ID — so `priority` is the
deterministic ordering knob. `prefer: { ids, targets, providers, models, tags }` steers;
`avoid` with the same shape rejects. `require: { liveControl, taskflow, provider,
minContextTokens }` rejects anything that cannot satisfy the run.

There is deliberately **no automatic failover to the next candidate** after launch for write-capable runs:
a retry could duplicate side effects. The exception is read-only transport/timeout/task failure, which retries once on the next viable ranked route (`receipt.routingFallbacks` records the switch; opt out with `metadata.routing.fallbacks: false`). To compare or hedge, fan out with
`handoff_compare` (2-16 read-only lanes, one receipt per lane) or retry explicitly
after reviewing the trace. Read-only compare and review accept the six targets with native read-only support; Amp is excluded because its downstream adapter requires writes. Retrying a compare after partial failure needs a new base `requestId` — lane IDs are deterministic (`<base>:<lane>`), so the same key returns the existing lane receipts instead of rerunning. See `routing.md` deliberate limits.

Generic ACP is excluded from read-only compare and review for the same reason: its downstream contract requires explicit write approval.

## Model selection per target

| Target | Model flag | Default when omitted | Notes |
|---|---|---|---|
| Generic ACP | rejected unless independently observed | registered agent default | `route.agent` is required. Explicit model pins reject unless a documented available-model/configuration method and the selected model are independently observed. The route is write-only, excluded from bare auto, and resumes through the observed `execution.sessionId` only when the negotiated agent supports it. |
| OpenCode | optional (policy-selected) | policy candidate | A bare target ranks only OpenCode candidates and policy fills `route.model`; set it explicitly only when the user names a model. Never rely on interactive/default-model state. `route.harnessVersion: v2` required for live steer/reroute; V1 controls fail closed. |
| Pi | optional | profile default | Omit for profile default; pass through when the user names one. `thinking` must suit the model (DeepSeek V4 routes use `high`/`xhigh`). |
| Cursor | optional | Cursor default | Passed verbatim as `cursor-agent --model`. Discover with `cursor-agent --list-models`. Only earns a lane with a NAMED cheap model (grok/composer); the bare default adds nothing over Pi. |
| Claude | optional | config chain | Passed verbatim as `claude --model` (alias or full ID: `sonnet`, `opus`, `claude-opus-5`). Verify the actual model from `modelUsage` — org restrictions can substitute. The ONLY home for Claude models. |
| Codex | optional | Codex default | Passes the selected model as `codex exec -m`. A named model enables an automatic lane. Resume via `exec resume`. |
| Gemini | optional | Gemini native default | Explicit model pins are passed only through the adapter's supported native model field. Native execution modes are not model IDs. Resume with `execution.sessionId`; session transport and live controls are unsupported. |
| Amp | rejected | Amp native selection | Use only `route.variant` `low`, `medium`, `high`, or `ultra`; arbitrary provider/model/thinking fields reject. Requires explicit write approval with empty tools and no cost budget on native Linux/macOS or with the entire MCP server inside WSL. Resume with `execution.sessionId` and omit `route.variant` because the existing thread retains its mode; session transport, live controls, read-only, and detached orbs are unsupported. |
| DSH | — | not a target | Protocol rejects `target: "dsh"`. Run DeepSeek models via Pi or OpenCode provider routes. |

Preserve explicit model and effort pins. Use the leaf defaults when preparing
a new Codex route and check the active catalog before selecting a model on
another provider.

## Worked example

```json
{
  "global": {
    "defaults": { "weights": { "quality": 4, "speed": 3, "efficiency": 3, "reliability": 4 } },
    "candidates": [
      {
        "id": "fast-cursor",
        "target": "cursor",
        "route": { "provider": "cursor", "model": "composer-2.5" },
        "scores": { "quality": 6, "speed": 10, "efficiency": 9, "reliability": 8 },
        "capabilities": { "readOnly": true, "write": true, "taskflow": false, "liveControl": false, "maxContextTokens": 128000 },
        "costUsd": 0.2, "latencyMs": 1000, "tags": ["fast", "cheap"], "priority": 5
      },
      {
        "id": "deep-opencode",
        "target": "opencode",
        "route": { "provider": "your-gateway", "model": "your-strong-model", "harnessVersion": "v2" },
        "scores": { "quality": 10, "speed": 5, "efficiency": 5, "reliability": 9 },
        "capabilities": { "readOnly": true, "write": true, "taskflow": true, "liveControl": true, "maxContextTokens": 256000 },
        "costUsd": 1.5, "latencyMs": 5000, "tags": ["deep", "review"], "priority": 10
      }
    ],
    "rules": [
      { "id": "security-prefers-depth", "priority": 10,
        "when": { "taskAny": ["security", "audit", "architecture"] },
        "apply": { "weights": { "quality": 10, "speed": 1 }, "prefer": { "tags": ["deep"] } } },
      { "id": "urgent-prefers-speed", "priority": 20,
        "when": { "taskAny": ["urgent", "quick", "fast"] },
        "apply": { "weights": { "quality": 3, "speed": 10 }, "prefer": { "tags": ["fast"] } } }
    ]
  }
}
```

Every decision lands in `receipt.routingDecision` with scopes, matched rules, rejected
candidates and reasons, score breakdown, and deterministic alternatives — IDs and reason
codes only, never task text or credentials.
