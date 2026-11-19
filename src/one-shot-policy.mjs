export function assertPromptOnlyWorkflow(target, workflow) {
  if (workflow == null) return;
  throw Object.assign(new Error(`${target} does not accept a workflow field in handoff requests`), {
    details: { kind: "policy", field: "workflow" },
  });
}
