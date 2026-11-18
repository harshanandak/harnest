export const meta = {
  name: "dynamic-verify-loop",
  description: "Revise a draft using verifier feedback for a bounded number of rounds.",
};

if (typeof args?.task !== "string" || !args.task.trim()) throw new Error("args.task must be a non-empty string");
const maxRounds = args.maxRounds === undefined ? 3 : args.maxRounds;
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 500) {
  throw new Error("args.maxRounds must be an integer between 1 and 500");
}

const schema = {
  type: "object",
  properties: { passed: { type: "boolean" }, feedback: { type: "string" } },
  required: ["passed", "feedback"],
  additionalProperties: false,
};
let feedback = null;
let result = null;
for (let round = 1; round <= maxRounds; round++) {
  await phase(`Round ${round}`);
  const draft = await agent("Write a concise answer to the supplied task. Address any feedback from the previous round.", {
    label: "Draft answer",
    context: { task: args.task, round, feedback },
  });
  result = draft?.finalText ?? null;
  if (result === null) {
    feedback = "The draft agent returned no answer. Produce a complete answer.";
    continue;
  }
  const verification = await agent("Check the candidate against the supplied task. Return only JSON with a boolean passed and a feedback string. If it fails, give specific revisions.", {
    label: "Verify answer",
    context: { task: args.task, round, candidate: result },
    schema,
  });
  const verdict = verification ? JSON.parse(verification.finalText) : null;
  if (verdict?.passed) return { verified: true, rounds: round, result, message: `verified after ${round} round${round === 1 ? "" : "s"}` };
  feedback = verdict?.feedback ?? "The verifier returned no verdict. Check the answer against the task and revise it.";
}
return { verified: false, rounds: maxRounds, result, message: `not verified after ${maxRounds} round${maxRounds === 1 ? "" : "s"}` };
