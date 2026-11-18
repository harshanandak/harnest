import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("receipt execution schema is unique, closed, and includes transport evidence", async () => {
  const text = await readFile(new URL("../schemas/handoff-receipt.schema.json", import.meta.url), "utf8");
  assert.equal(text.match(/"execution"\s*:/g)?.length, 1, "duplicate JSON keys silently replace the rich execution contract");
  const execution = JSON.parse(text).properties.execution;
  assert.equal(execution.additionalProperties, false);
  assert.deepEqual(execution.properties.transport, { enum: ["oneshot", "session"] });
  for (const key of ["background", "timeoutMs", "foregroundConverted", "effectivePolicy", "launchFlags"]) {
    assert.ok(execution.properties[key], `missing execution.${key}`);
  }
});
