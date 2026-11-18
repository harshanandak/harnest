import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { dynamicInputSchema, dynamicToolDefinitions } from "../src/dynamic-tools.mjs";

const definitions = dynamicToolDefinitions({});
function scopedSchema(tool) {
  const schema = structuredClone(tool.parameters);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) value.$ref = `#/$defs/${tool.name}/${value.$ref.slice(2)}`;
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return schema;
}
const schemas = {
  "dynamic-workflow.schema.json": z.toJSONSchema(dynamicInputSchema),
  "dynamic-tools.schema.json": { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: Object.fromEntries(definitions.map((tool) => [tool.name, scopedSchema(tool)])) },
};
for (const [file, schema] of Object.entries(schemas)) await writeFile(new URL(`../schemas/${file}`, import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Generated ${Object.keys(schemas).length} dynamic workflow schemas.`);
