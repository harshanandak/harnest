# Routing precedence (condensed)

Full contract: `docs/preferences.md`, `docs/routing.md`.

Version choice is `modelVersion: latest` (default) or `pin`, in saved settings or request `metadata.routing`. Latest follows native catalog releases within the same model family/tier; pin keeps the exact version and skips discovery. A named provider/model fixes the route but still follows latest unless modelVersion is pin. For “keep this exact version,” set pin explicitly. Report unavailable or stale discovery as unverified, not latest.

For routing changes in chat: call `handoff_routing_get`, discover any named models through the host catalog, apply only the user's requested preferences with `handoff_routing_configure` and its returned revision, then call `handoff_routing_preview` for the intended task. Report the final harness/provider/model/thinking and any higher-scope or resolver override. Save reusable choices as named presets; choose one per request with `metadata.routing.preset`, or null for base settings. A preset called `free` is not a spending guard: honor a free-only request with verified free endpoints and explicit routes, rather than claiming a preference ranking prevents paid fallback.

1. `routing.global` → 2. user policy (`~/.harnest/routing.json`) → 3. `routing.project` → 4. `routing.sessions[sessionId]` → 5. request `metadata.routing` → 6. trusted local resolver (`HARNEST_ROUTER`).
2. An explicit `route.provider`/`route.model` **pins** unless `metadata.routing.mode` is `auto` (policy selects) or `prefer` (explicit route gets a strong bonus).
3. Order: reject incapable candidates first (target, write/read-only, live-control, context, budget, deadline, avoid-list), then score quality/speed/efficiency/reliability with prefer bonuses; ties break on `priority`, then candidate ID.
4. Read-only transport/timeout failures retry once on the next ranked route (`receipt.routingFallbacks`); write runs never fail over. Opt out: `metadata.routing.fallbacks: false`.
5. Use the model and effort the user names, then their routing preferences. When neither supplies a model, omit `route.model` so the downstream CLI can use its configured default. If the user requests automatic routing, policy chooses the route in-process. A bare `target` pins that harness and ranks only its candidates; OpenCode still needs a resolved `route.model` before dispatch, so a preset-only machine must map one via `models.opencode`.
