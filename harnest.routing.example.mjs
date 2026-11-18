// Optional trusted post-policy hook. Declarative Routing V2 runs first; use this
// only for machine-local facts that cannot live in JSON (live headroom, a private
// benchmark service, or provider auth state). Request content cannot select this file.
export function resolveRoute({ request, options }) {
  const blocked = new Set(options.blockedProviders || []);
  if (blocked.has(request.route.provider)) {
    const fallback = (options.fallbacks || []).find((candidate) => !blocked.has(candidate.provider));
    if (!fallback) return null;
    return {
      target: fallback.target || request.target,
      route: { ...request.route, provider: fallback.provider, model: fallback.model },
      explanation: { reason: "selected configured fallback for blocked provider" },
    };
  }
  return null;
}
