export function resolve(specifier, context, nextResolve) {
  if (["taskflow-mcp-core/server", "taskflow-core", "pi-taskflow"].includes(specifier)) {
    if (process.env.REJECT_TASKFLOW_MODE === "eval") {
      throw new Error("Taskflow runtime exploded during evaluation");
    }
    const error = new Error("TASKFLOW_IMPORT_BLOCKED: Taskflow is optional and must only load for explicit workflow requests");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}
