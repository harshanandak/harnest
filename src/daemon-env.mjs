export function withoutHarnestToken(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^HARNEST_.*TOKEN/i.test(name)));
}
