import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { graphInputSchema } from "../src/graph-tools.mjs";

const schema = z.toJSONSchema(graphInputSchema);
schema.$id = "https://local.harnest/schemas/agent-graph.schema.json";
schema.title = "Harnest mixed-harness DAG";
await writeFile(new URL("../schemas/agent-graph.schema.json", import.meta.url), JSON.stringify(schema, null, 2) + "\n");
console.log("Generated schemas/agent-graph.schema.json from graph tool schema");
