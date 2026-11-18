// Fixture route resolver for dynamic-worker tests: the tests pin routes in the
// spec, so the worker must not re-resolve them through host policy.
export async function routeResolver(request) {
  return request;
}

export default { routeResolver };
