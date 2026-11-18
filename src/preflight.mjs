import { stat } from "node:fs/promises";
import { normalizeRequest } from "./protocol.mjs";
import { createRouteResolver } from "./routing.mjs";

export async function preflight(input, options = {}) {
  const normalized = normalizeRequest(input);
  const resolver = options.routeResolver || createRouteResolver(options.routing);
  const request = normalizeRequest(await resolver(normalized));
  const cwd = await stat(request.cwd).catch(() => null);
  if (!cwd?.isDirectory()) {
    throw Object.assign(new TypeError("cwd must be an existing directory"), { details: { kind: "validation" } });
  }
  return {
    requestId: request.requestId,
    contextDigest: request.contextDigest,
    target: request.target,
    route: request.route,
    routingDecision: request.metadata?.harnest?.routingDecision ?? null,
    checks: ["request", "routing-policy", "cwd"],
    inferenceStarted: false,
    unchecked: ["provider availability", "authentication", "quota", "adapter execution"],
  };
}
