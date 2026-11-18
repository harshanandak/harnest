export const meta = {
  name: "dynamic-review",
  description: "Review parameterized files, then consolidate successful findings.",
  phases: ["Inspect", "Consolidate"],
};

if (!Array.isArray(args.files) || !args.files.length) throw new Error("args.files must be a non-empty list");
await phase("Inspect");
const findings = await pipeline(args.files, async (file) => {
  return await agent(`Review ${file} for correctness. Read only. Return concise findings.`, {
    label: `Review ${file}`,
  });
});
await phase("Consolidate");
const successful = findings.filter((item) => item !== null);
if (!successful.length) return { summary: "No review succeeded", findings: [] };
return await agent("Consolidate the supplied review findings. Do not change files.", {
  label: "Consolidate reviews",
  context: { findings: successful },
});
