import assert from "node:assert/strict";
import test from "node:test";

import { summarizeUsage } from "../src/usage.mjs";

const EMPTY = {
  inputTokens: null,
  uncachedInputTokens: null,
  inputSemantics: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
};

test("summarizeUsage maps the Claude exclusive cache shape", () => {
  // Anthropic input_tokens excludes cache; the inclusive total adds it back.
  assert.deepEqual(
    summarizeUsage("claude", {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalCostUsd: 0.01,
    }),
    {
      inputTokens: 115,
      uncachedInputTokens: 100,
      inputSemantics: "exclusive",
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.01,
    },
  );
});

test("summarizeUsage leaves the Claude total null when a cache counter was not reported", () => {
  // A missing counter is unreported, not zero; the total must not invent it.
  assert.deepEqual(
    summarizeUsage("claude", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10 }),
    {
      inputTokens: null,
      uncachedInputTokens: 100,
      inputSemantics: "exclusive",
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: null,
      costUsd: null,
    },
  );
});

test("summarizeUsage treats Codex input_tokens as the inclusive total", () => {
  assert.deepEqual(
    summarizeUsage("codex", { input_tokens: 12, cached_input_tokens: 8, output_tokens: 4, reasoning_output_tokens: 1 }),
    {
      inputTokens: 12,
      uncachedInputTokens: 4,
      inputSemantics: "inclusive",
      outputTokens: 4,
      cacheReadTokens: 8,
      cacheWriteTokens: null,
      costUsd: null,
    },
  );
});

test("summarizeUsage refuses to clamp a Codex cache count that contradicts the input count", () => {
  assert.deepEqual(
    summarizeUsage("codex", { input_tokens: 4, cached_input_tokens: 8, output_tokens: 1 }),
    {
      inputTokens: 4,
      uncachedInputTokens: null,
      inputSemantics: "inclusive",
      outputTokens: 1,
      cacheReadTokens: 8,
      cacheWriteTokens: null,
      costUsd: null,
    },
  );
});

test("summarizeUsage rejects negative and non-finite counters", () => {
  assert.deepEqual(summarizeUsage("codex", { input_tokens: -1, cached_input_tokens: 2, output_tokens: 1 }), {
    inputTokens: null,
    uncachedInputTokens: null,
    inputSemantics: null,
    outputTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: null,
    costUsd: null,
  });
  assert.deepEqual(summarizeUsage("claude", { inputTokens: 1, outputTokens: Number.NaN, cacheReadTokens: -5 }), {
    inputTokens: null,
    uncachedInputTokens: 1,
    inputSemantics: "exclusive",
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  });
});

test("summarizeUsage keeps an OpenCode accumulator zero unreported when no event supplied it", () => {
  const accumulated = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  assert.deepEqual(summarizeUsage("opencode", accumulated, { reported: {} }), EMPTY);
});

test("summarizeUsage reports an explicit OpenCode cache miss as zero, not null", () => {
  const accumulated = { input: 3, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 9, turns: 1 };
  assert.deepEqual(
    summarizeUsage("opencode", accumulated, { reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true } }),
    {
      inputTokens: 3,
      uncachedInputTokens: 3,
      inputSemantics: "exclusive",
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  );
});

test("summarizeUsage leaves the OpenCode total null when a cache counter was not reported", () => {
  const accumulated = { input: 3, output: 6, cacheRead: 2, cacheWrite: 0, cost: 0.01, contextTokens: 9, turns: 1 };
  assert.deepEqual(
    summarizeUsage("opencode", accumulated, { reported: { input: true, output: true, cacheRead: true, cost: true } }),
    {
      inputTokens: null,
      uncachedInputTokens: 3,
      inputSemantics: "exclusive",
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: null,
      costUsd: 0.01,
    },
  );
});

test("summarizeUsage maps the verified installed Pi stats shape", () => {
  // C:\...\@earendil-works\pi-coding-agent getSessionStats():
  // tokens:{input,output,cacheRead,cacheWrite,total} where
  // total = input + output + cacheRead + cacheWrite proves input excludes cache.
  assert.deepEqual(
    summarizeUsage("pi", {
      sessionId: "session-pi-001",
      tokens: { input: 12, output: 4, cacheRead: 8, cacheWrite: 2, total: 26 },
      cost: 0.03,
    }),
    {
      inputTokens: 22,
      uncachedInputTokens: 12,
      inputSemantics: "exclusive",
      outputTokens: 4,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      costUsd: 0.03,
    },
  );
});

test("summarizeUsage keeps flat non-token Pi shapes unknown instead of claiming a total", () => {
  assert.deepEqual(
    summarizeUsage("pi", { inputTokens: 20, outputTokens: 5, cacheReadTokens: 7, costUsd: 0.03 }),
    {
      inputTokens: null,
      uncachedInputTokens: null,
      inputSemantics: "unknown",
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: null,
      costUsd: 0.03,
    },
  );
  assert.deepEqual(summarizeUsage("pi", null), null);
});

test("summarizeUsage never claims exclusive semantics for Cursor cache counters", () => {
  // Cursor wraps several providers; counter presence alone proves nothing.
  assert.deepEqual(
    summarizeUsage("cursor", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }),
    {
      inputTokens: null,
      uncachedInputTokens: null,
      inputSemantics: "unknown",
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: null,
    },
  );
});

test("Gemini and Amp usage stays unknown until native counter semantics are verified", () => {
  for (const target of ["gemini", "amp"]) {
    assert.deepEqual(summarizeUsage(target, {
      inputTokens: 10,
      outputTokens: 5,
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
      costUsd: 0.01,
    }), EMPTY);
  }
});
