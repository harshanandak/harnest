export function assertPromptOnlyWorkflow(target, workflow) {
  if (workflow?.spec == null && workflow?.nodes == null) return;
  throw Object.assign(new Error(`${target} is a one-shot adapter and cannot execute a Taskflow graph; select pi or opencode for workflow.spec/workflow.nodes`), {
    details: { kind: "policy" },
  });
}
