export const meta = {
  name: "dynamic-verification",
  description: "Branch and fan out without coordinator model turns.",
  phases: ["Inspect", "Check"],
};

await phase("Inspect");
const result = await agent('Read the supplied topic and return only a JSON object with risk set to "low" or "high".', {
  label: "Classify risk",
  context: { topic: args.topic },
  schema: { type: "object", properties: { risk: { enum: ["low", "high"] } }, required: ["risk"], additionalProperties: false },
});
if (!result) return { classification: null, checks: [] };
const classification = JSON.parse(result.finalText);
await phase("Check");
const topics = classification.risk === "high" ? ["correctness", "permissions", "recovery"] : ["correctness"];
const checks = await pipeline(topics, (topic) => agent(`Review ${topic} for the supplied task. Read only.`, {
  label: topic,
  context: { topic: args.topic, classification },
}));
return { classification, checks };
