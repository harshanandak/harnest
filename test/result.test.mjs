import assert from "node:assert/strict";
import test from "node:test";
import { compactText, structuredResult, summarizeEvents } from "../src/result.mjs";

test("structured result preserves only the parent-visible completion envelope", () => {
  const result = structuredResult(JSON.stringify({
    finalText: "done",
    evidence: ["marker matched"],
    tests: ["read passed"],
    risks: [],
    ignored: { raw: "event payload" },
  }), { eventSummary: { count: 400, types: ["message"] } });

  assert.deepEqual(result, {
    finalText: "done",
    summary: "done",
    evidence: ["marker matched"],
    tests: ["read passed"],
    risks: [],
    eventSummary: { count: 400, types: ["message"] },
  });
});

test("plain text results stay valid and event history is summarized", () => {
  const result = structuredResult("plain completion", {
    eventSummary: summarizeEvents([
      { type: "message" },
      { event: { type: "tool" } },
      { type: "message" },
    ]),
  });
  assert.equal(result.finalText, "plain completion");
  assert.deepEqual(result.eventSummary, { count: 3, types: ["message", "tool"] });
  assert.deepEqual(result.evidence, []);
});

test("structured result extracts a trailing completion object after model preamble", () => {
  const result = structuredResult(
    'Verified the marker.\n\n{"finalText":"done","evidence":["marker matched"],"tests":["read passed"],"risks":[]}',
  );
  assert.equal(result.finalText, "done");
  assert.deepEqual(result.evidence, ["marker matched"]);
  assert.deepEqual(result.tests, ["read passed"]);
  assert.deepEqual(result.risks, []);
});

test("large result text is bounded", () => {
  const compacted = compactText("x".repeat(9_000));
  assert.ok(compacted.length < 8_100);
  assert.match(compacted, /truncated 1000 chars/);
});

test("parent-visible completion fields are hard-bounded", () => {
  const huge = "x".repeat(2_000_000);
  const result = structuredResult(JSON.stringify({
    finalText: huge,
    summary: huge,
    evidence: Array.from({ length: 200 }, () => huge),
    tests: [huge],
    risks: [huge],
  }));
  assert.ok(result.finalText.length < 65_000);
  assert.ok(result.summary.length < 17_000);
  assert.equal(result.evidence.length, 100);
  assert.ok(result.evidence.every((item) => item.length < 5_000));
  assert.ok(JSON.stringify(result).length < 600_000);
});
