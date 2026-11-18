import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { dynamicInputSchema } from "../src/dynamic-tools.mjs";
import { createAdapter } from "../src/adapters/index.mjs";
import { graphInputSchema } from "../src/graph-tools.mjs";
import { normalizeRequest, TARGETS } from "../src/protocol.mjs";
import { runtimeInfo } from "../src/runtime-info.mjs";

const targets = ["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"];
const readOnlyTargets = targets.filter((target) => !["amp", "acp"].includes(target));

test("Gemini, Amp, and ACP are admitted across canonical runtime and static schema surfaces", async () => {
  assert.deepEqual([...TARGETS], targets);
  assert.deepEqual(runtimeInfo().targets, targets);

  for (const target of ["gemini", "amp", "acp"]) {
    const targetOptions = target === "amp" ? { route: { variant: "medium" }, policy: { write: true } }
      : target === "acp" ? { route: { agent: "fixture" }, policy: { write: true } } : {};
    const request = normalizeRequest({ requestId: `request-${target}`, target, task: "inspect", cwd: process.cwd(), ...targetOptions });
    assert.equal(request.target, target);
    assert.equal(graphInputSchema.safeParse({
      requestId: `graph-${target}`,
      cwd: process.cwd(),
      ...(["amp", "acp"].includes(target) ? { policy: { write: true } } : {}),
      nodes: [{ id: "inspect", target, task: "inspect", ...targetOptions }],
    }).success, true);
    assert.equal(dynamicInputSchema.safeParse({
      requestId: `dynamic-${target}`,
      cwd: process.cwd(),
      source: "return null;",
      target,
      ...targetOptions,
    }).success, true);
  }

  const load = async (name) => JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
  const requestSchema = await load("handoff-request.schema.json");
  const receiptSchema = await load("handoff-receipt.schema.json");
  const comparisonSchema = await load("handoff-comparison.schema.json");
  assert.deepEqual(requestSchema.properties.target.enum, targets);
  assert.deepEqual(requestSchema.properties.metadata.properties.routing.properties.target.enum, targets);
  assert.deepEqual(receiptSchema.properties.target.enum, targets);
  assert.deepEqual(receiptSchema.properties.usageAttempts.items.properties.target.enum, targets);
  assert.deepEqual(comparisonSchema.properties.candidates.items.properties.target.enum, readOnlyTargets);
  assert.deepEqual(comparisonSchema.properties.request.allOf[1].properties.target.enum, readOnlyTargets);

  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(requestSchema);
  const validateComparison = ajv.compile(comparisonSchema);
  const comparison = (target) => ({
    request: { requestId: `compare-${target}`, target, task: "inspect", cwd: process.cwd() },
    candidates: [
      { name: "first", target, route: { model: target === "gemini" ? "gemini-fixture" : "fixture" } },
      { name: "second", target, route: { model: target === "gemini" ? "gemini-fixture" : "fixture" } },
    ],
  });
  for (const target of readOnlyTargets) assert.equal(validateComparison(comparison(target)), true, target);
  assert.equal(validateComparison(comparison("amp")), false, "static comparison must reject read-only Amp before dispatch");
  assert.equal(validateComparison(comparison("acp")), false, "static comparison must reject write-only ACP before dispatch");
});

test("session transport remains exclusive to Claude, Codex and Cursor", () => {
  for (const target of ["claude", "codex", "cursor"]) {
    const request = normalizeRequest({
      requestId: `session-${target}`, target, task: "inspect", cwd: process.cwd(), execution: { transport: "session" },
    });
    assert.equal(request.execution.transport, "session");
  }
  for (const target of ["opencode", "pi", "gemini", "amp", "acp"]) {
    assert.throws(() => normalizeRequest({
      requestId: `session-${target}`, target, task: "inspect", cwd: process.cwd(), execution: { transport: "session" },
    }), /session transport.*claude, codex, or cursor/i);
  }
});

test("the shared adapter factory constructs every registered target and fails closed on unsupported sessions", () => {
  for (const target of targets) assert.ok(createAdapter(target, target === "acp" ? { acp: { registrations: { fixture: { command: "fixture", args: [], trusted: true } } } } : {}), target);
  for (const target of ["opencode", "pi", "gemini", "amp", "acp"]) {
    assert.throws(() => createAdapter(target, {}, { execution: { transport: "session" } }), /session transport.*claude, codex, or cursor/i);
  }
});
