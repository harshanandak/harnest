// Saved dynamic workflow fixture used by test/dynamic-engine.test.mjs.
// This file is workflow source data, not an executable Node module: it uses a
// literal meta export plus a top-level `return`, which the engine wraps in an
// async function before evaluation.
export const meta = {
  name: "fixture-dynamic-workflow",
  description: "Fan out over args.items and reduce the agent results",
  phases: ["fan-out", "reduce"],
};

log(`starting ${args.items.length} items`);
await phase("fan-out");
const results = await parallel(
  args.items.map((item) => async () => {
    const response = await agent(`process ${item}`, { label: `item-${item}` });
    return response.value;
  }),
);
await phase("reduce");
return results.reduce((sum, value) => sum + value, 0);
