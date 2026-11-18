import { Companion } from "./companion.mjs";
import { GraphRunner } from "./graph.mjs";
import { lazyDynamicRunner } from "./dynamic-tools.mjs";
import { RoutingSettings } from "./routing-settings.mjs";
import { WorkflowRegistry } from "./workflow-registry.mjs";

export function createRuntimeServices(options = {}) {
  const companion = options.companion || new Companion({ detachBackground: true, ...options });
  const graphs = options.graphs || new GraphRunner({ companion, graphDir: options.graphDir });
  const dynamic = options.dynamic || lazyDynamicRunner({ companion, workflowDir: options.workflowDir });
  const workflowRegistry = options.workflowRegistry || new WorkflowRegistry();
  const routingSettings = options.routingSettings || new RoutingSettings({
    modelCatalog: companion.modelCatalog,
    config: options.routing?.config,
    env: options.routing?.env,
    policyPath: options.routing?.policyFile,
  });

  return {
    companion, graphs, dynamic, workflowRegistry, routingSettings,
    isBusy: () => Boolean(companion.running?.size || graphs.running?.size || dynamic.isBusy?.()),
    close: () => companion.close(),
  };
}
