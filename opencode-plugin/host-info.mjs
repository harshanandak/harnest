const WORKERS = [
  {
    agent: "opencode-worker",
    target: "opencode",
    notes: "Name the target (or auto) and policy picks the model; set route.model only when the user names one. OpenCode V2 supports live steering on server-attached handoffs. Its server owns tool permissions.",
  },
  {
    agent: "pi-worker",
    target: "pi",
    notes: "Route or profile default is fine. Live steer/reroute supported.",
  },
  {
    agent: "cursor-worker",
    target: "cursor",
    notes: "One-shot print mode with stream-json deltas in trace. Read-only maps to --mode ask; write uses --force. Resume via execution.sessionId; no live message/reroute.",
  },
  {
    agent: "claude-worker",
    target: "claude",
    notes: "One-shot print mode with stream-json deltas in trace. Read-only maps to --permission-mode plan; write uses acceptEdits. Supports maxCostUsd via --max-budget-usd. Resume via execution.sessionId; no live message/reroute.",
  },
  {
    agent: "codex-worker",
    target: "codex",
    notes: "One-shot exec with JSONL events in trace. Read-only maps to --sandbox read-only; write uses workspace-write (never danger-full-access). Resume via execution.sessionId; no live message/reroute.",
  },
  {
    agent: "amp-worker",
    target: "amp",
    notes: "Prompt-only attached one-shot, write-only with explicit approval. Requires empty tools and null maxCostUsd. Supports native Linux/macOS or the entire MCP server running inside WSL; native Windows rejects before inference. Generated settings are risk reduction, not containment. Resume via execution.sessionId; session transport and live controls are unsupported.",
  },
  {
    agent: "acp-worker",
    target: "acp",
    notes: "Attached one-shot selected by an explicitly trusted route.agent. Write-only: requires policy.write=true and metadata.harnest.writeApproved=true. Resume or load the negotiated native session via execution.sessionId; no live message/reroute, and execution.transport=session is unsupported.",
  },
]

export function hostInfoSnapshot(env = process.env) {
  const router = env.HARNEST_ROUTER || ""
  return {
    leadHost: "opencode",
    mcpServerName: "harnest",
    toolPrefix: "harnest_",
    tools: [
      "harnest_handoff_workflow",
      "harnest_handoff_compare",
      "harnest_handoff_sessions",
      "harnest_handoff_status",
      "harnest_handoff_trace",
      "harnest_handoff_result",
      "harnest_handoff_message",
      "harnest_handoff_reroute",
      "harnest_handoff_cancel",
      "harnest_handoff_resume",
      "harnest_handoff_review",
      "harnest_handoff_post",
      "harnest_handoff_read",
      "harnest_handoff_fleet",
      "harnest_handoff_graph_validate",
      "harnest_handoff_graph_start",
      "harnest_handoff_graph_status",
      "harnest_handoff_graph_result",
      "harnest_handoff_graph_cancel",
      "harnest_handoff_graph_resume",
      "harnest_handoff_host_info",
      "harnest_handoff_routing_get",
      "harnest_handoff_routing_configure",
      "harnest_handoff_routing_preview",
      ...["validate", "start", "status", "result", "history", "inspect", "control", "resume", "save", "list", "get", "revisions", "delete", "invoke"].map((name) => `harnest_handoff_dynamic_${name}`),
    ],
    launchPath: {
      direct: "Call harnest_handoff_workflow directly as an MCP tool when child visibility is not needed.",
      nativeChild:
        "Call the subagent tool with the matching worker agent ID (opencode-worker, pi-worker, cursor-worker, claude-worker, codex-worker, amp-worker, acp-worker) so the handoff runs in a visible OpenCode child session; the worker pages status/trace and returns the durable receipt.",
    },
    workers: WORKERS,
    graphWorkflows: "Harnest coordinates mixed-harness DAGs. Validate/start with handoff_graph_*, inspect node child job IDs, and selectively resume unsuccessful steps. Native panels are host-dependent; graph status is the portable view.",
    dynamicWorkflows: "Harnest owns JavaScript orchestration across all supported harnesses. Use handoff_dynamic_* for scripts, saved versions, history and durable controls. Recovery reuses an ordered prefix. Claude's workflow runtime is not required.",
    writeApproval: {
      marker: "metadata.harnest.writeApproved=true",
      appliesTo: "write-capable handoff_workflow and handoff_graph_start calls on guarded hosts with policy.write=true",
      scope: "The lead confirms the intended write scope before setting the marker; there is no separate writeScope protocol field.",
    },
    nestedHandoffs: "A nested handoff remains subject to the child host's approval and sandbox restrictions and cannot widen them.",
    routingResolverConfigured: Boolean(router),
    routingResolverPath: router || null,
    routingResolverDiagnostics: "Call harnest_handoff_host_info for the MCP process's cached/source resolver status and fingerprints.",
    controlSemantics: {
      acknowledged: "applied",
      uncertain: "transport acknowledgement lost; reconcile from downstream trace",
      opencode: "server-attached handoffs support live message/reroute; shared-service graph nodes use graph controls",
      cursor: "oneshot rejects live controls; session uses ACP cancel/model negotiation and rejects mid-turn messages",
      claude: "oneshot rejects live controls; session uses SDK streaming guidance with consumption evidence and acknowledged setModel",
      codex: "oneshot rejects live controls; session uses app-server turn/steer and owned queued follow-ups",
      amp: "attached oneshot rejects live controls and execution.transport=session; follow-ups resume by native thread identity",
      acp: "attached oneshot rejects live controls and execution.transport=session; follow-ups resume or load the negotiated native session identity",
    },
  }
}
