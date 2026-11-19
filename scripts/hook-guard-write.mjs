// Claude PreToolUse guard: block write-capable handoff_workflow calls that lack
// explicit lead approval. Approval marker is
// request.metadata.harnest.writeApproved === true. Exit 2 denies;
// anything else (exit 0)
// fails OPEN per repo convention: parse errors, missing fields, unexpected
// shapes, non-handoff tools, and read-only calls are never blocked.
let raw = "";
process.stdin.setEncoding("utf8");
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}
try {
  const hook = JSON.parse(raw || "{}");
  const toolName = String(hook?.tool_name ?? hook?.tool ?? "");
  if (!toolName.includes("handoff_workflow") && !toolName.includes("handoff_graph_start")) process.exit(0);
  const toolInput = hook?.tool_input ?? hook?.input ?? {};
  if (!toolInput || typeof toolInput !== "object") process.exit(0);
  const request = toolInput.graph ?? toolInput.request ?? toolInput;
  if (!request || typeof request !== "object") process.exit(0);
  const policy = request.policy;
  const writeCapable = policy?.write === true;
  if (!writeCapable) process.exit(0);
  if (request.metadata?.harnest?.writeApproved === true) process.exit(0);
  process.stderr.write(
    "Blocked: handoff_workflow or handoff_graph_start requests write-capable policy without lead approval. Confirm the write scope, then re-issue with the missing field metadata.harnest.writeApproved=true.\n",
  );
  process.exit(2);
} catch {
  process.exit(0);
}
