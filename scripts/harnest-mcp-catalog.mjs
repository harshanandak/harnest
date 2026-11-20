import assert from "node:assert/strict";

export function assertMcpCatalog(listed) {
  const names = listed.tools.map((tool) => tool.name).sort();
  const traceSchema = listed.tools.find((tool) => tool.name === "handoff_trace").inputSchema;
  assert.equal(traceSchema.type, "object");
  assert.equal(traceSchema.allOf, undefined, "closed disjoint allOf objects make every trace argument impossible in strict hosts");
  assert.deepEqual(Object.keys(traceSchema.properties).sort(), ["afterSequence", "itemCursor", "itemOffset", "jobId", "limit", "requestId"]);
  assert.equal(traceSchema.properties.itemOffset.minimum, 1);
  assert.ok(!traceSchema.required?.includes("itemOffset"));
  const workflowSchema = listed.tools.find((tool) => tool.name === "handoff_workflow").inputSchema.properties.request;
  assert.equal(workflowSchema.properties.route.additionalProperties, false);
  assert.ok(workflowSchema.properties.route.properties.thinking);
  assert.equal(workflowSchema.properties.policy.additionalProperties, false);
  assert.ok(workflowSchema.properties.policy.properties.write);
  const graphSchema = listed.tools.find((tool) => tool.name === "handoff_graph_start").inputSchema.properties.graph;
  assert.equal(graphSchema.properties.policy.additionalProperties, false);
  assert.ok(graphSchema.properties.policy.properties.write);
  assert.equal(graphSchema.properties.nodes.items.properties.route.additionalProperties, false);
  assert.ok(graphSchema.properties.nodes.items.properties.route.properties.thinking);
  assert.deepEqual(names, [
    "handoff_cancel",
    "handoff_compare",
    "handoff_dynamic_control",
    "handoff_dynamic_delete",
    "handoff_dynamic_get",
    "handoff_dynamic_history",
    "handoff_dynamic_inspect",
    "handoff_dynamic_invoke",
    "handoff_dynamic_list",
    "handoff_dynamic_result",
    "handoff_dynamic_resume",
    "handoff_dynamic_revisions",
    "handoff_dynamic_save",
    "handoff_dynamic_start",
    "handoff_dynamic_status",
    "handoff_dynamic_validate",
    "handoff_fleet",
    "handoff_graph_cancel",
    "handoff_graph_result",
    "handoff_graph_resume",
    "handoff_graph_start",
    "handoff_graph_status",
    "handoff_graph_validate",
    "handoff_host_info",
    "handoff_message",
    "handoff_page",
    "handoff_post",
    "handoff_read",
    "handoff_reroute",
    "handoff_result",
    "handoff_resume",
    "handoff_review",
    "handoff_routing_configure",
    "handoff_routing_get",
    "handoff_routing_preview",
    "handoff_sessions",
    "handoff_status",
    "handoff_trace",
    "handoff_workflow",
  ]);
  return names;
}
