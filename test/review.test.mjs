// Multi-model review: contract parsing, tallying, convergence, validation.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import {
  boardView,
  consolidateFindings,
  normalizeReviewers,
  normalizeRubric,
  parseLaneResult,
  reviewPrompt,
  tallyRound,
} from "../src/review.mjs";

const RUBRIC = normalizeRubric(["correctness", "security"]);

function block(scores, findings = ["f1"], to = []) {
  return `analysis text\n\`\`\`json\n${JSON.stringify({ scores, findings, to })}\n\`\`\`\n`;
}

test("rubric and reviewer validation fails closed", () => {
  assert.throws(() => normalizeRubric([]), /non-empty array/);
  assert.throws(() => normalizeRubric([{ factor: "a" }, { factor: "a" }]), /duplicate/);
  assert.throws(() => normalizeRubric([{ factor: "a", weight: 0 }]), /positive weight/);
  assert.deepEqual(normalizeRubric(["a", { factor: "b", weight: 2 }]), [{ factor: "a", weight: 1 }, { factor: "b", weight: 2 }]);
  assert.throws(() => normalizeReviewers([{ name: "only", route: { model: "m" } }]), /2 to 8/);
  assert.throws(() => normalizeReviewers([
    { name: "a", route: { model: "m" } },
    { name: "a", route: { model: "n" } },
  ]), /duplicate reviewer/);
  assert.throws(() => normalizeReviewers([
    { name: "a", route: { model: "m" } },
    { name: "b", route: {} },
  ]), /requires route.model/);
});

test("lane parsing enforces the output contract", () => {
  const good = parseLaneResult("a", block({ correctness: 9, security: 8 }, ["leak in auth"], [{ lane: "b", message: "check line 3" }]), RUBRIC);
  assert.equal(good.valid, true);
  assert.deepEqual(good.to, [{ from: "a", to: "b", message: "check line 3" }]);
  assert.deepEqual(parseLaneResult("a", "no block here", RUBRIC), { name: "a", valid: false, error: "no fenced ```json score block found" });
  assert.equal(parseLaneResult("a", block({ correctness: 9 }), RUBRIC).valid, false);
  assert.equal(parseLaneResult("a", block({ correctness: 11, security: 8 }), RUBRIC).valid, false);
  assert.equal(parseLaneResult("a", "```json\n{not json}\n```", RUBRIC).valid, false);
});

test("tally averages with weights and tracks quorum", () => {
  const parsed = [
    { name: "a", valid: true, scores: { correctness: 9, security: 7 }, findings: [], to: [] },
    { name: "b", valid: true, scores: { correctness: 7, security: 9 }, findings: [], to: [] },
    { name: "c", valid: false, error: "no block" },
  ];
  const tally = tallyRound(parsed, [{ factor: "correctness", weight: 3 }, { factor: "security", weight: 1 }]);
  assert.deepEqual(tally.voting, ["a", "b"]);
  assert.deepEqual(tally.abstained, [{ name: "c", error: "no block" }]);
  assert.equal(tally.laneScores[0].score, (9 * 3 + 7) / 4);
  assert.equal(tally.overall, ((9 * 3 + 7) / 4 + (7 * 3 + 9) / 4) / 2);
  assert.deepEqual(tally.factorMeans, { correctness: 8, security: 8 });
});

test("board routes directed messages and consolidation dedupes", () => {
  const parsed = [
    { name: "a", valid: true, scores: { correctness: 9, security: 9 }, findings: ["Shared flaw"], to: [{ from: "a", to: "b", message: "confirm this" }] },
    { name: "b", valid: true, scores: { correctness: 8, security: 8 }, findings: ["shared flaw", "Other issue"], to: [] },
  ];
  const tally = tallyRound(parsed, RUBRIC);
  const board = boardView(parsed, tally);
  assert.equal(board.lanes[0].scoreText, "9");
  assert.deepEqual(board.messages, [{ from: "a", to: "b", message: "confirm this" }]);
  const findings = consolidateFindings(parsed);
  assert.equal(findings.length, 2);
  const prompt = reviewPrompt({ task: "work", context: null, rubric: RUBRIC, round: 2, board, lane: "b", previous: null });
  assert.match(prompt, /Directed at you \(b\)/);
  assert.match(prompt, /confirm this/);
});

function reviewBase(overrides = {}) {
  return {
    requestId: "review-loop-test",
    target: "pi",
    task: "Review this plan.",
    cwd: process.cwd(),
    context: { plan: "do things" },
    policy: { write: false },
    ...overrides,
  };
}

async function tempCompanion(t, adapterFactory) {
  const root = await mkdtemp(join(tmpdir(), "harnest-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new Companion({ store: new JobStore(root), adapterFactory, routeResolver: async (request) => request });
}

test("review converges when the average meets threshold", async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      return { result: { finalText: block({ correctness: 9, security: 9, simplicity: 9 }, ["solid"]) }, route: request.route };
    },
  }));
  const out = await companion.review({
    request: reviewBase(),
    reviewers: [
      { name: "one", route: { provider: "a", model: "m1" } },
      { name: "two", route: { provider: "b", model: "m2" } },
    ],
    threshold: 9,
    rounds: 3,
  });
  assert.equal(out.state, "completed");
  assert.equal(out.final.overall, 9);
  assert.equal(out.rounds.length, 1);
  assert.deepEqual(out.final.voting, ["one", "two"]);
});

test("review runs convergence rounds and returns partial below threshold", async (t) => {
  const seen = [];
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      seen.push(request.task);
      const round = request.requestId.endsWith(":r1") ? 1 : 2;
      const scores = round === 1 ? { correctness: 6, security: 6, simplicity: 6 } : { correctness: 7, security: 7, simplicity: 7 };
      return { result: { finalText: block(scores, [`finding-r${round}`]) }, route: request.route };
    },
  }));
  const out = await companion.review({
    request: reviewBase({ requestId: "review-partial-test" }),
    reviewers: [
      { name: "one", route: { provider: "a", model: "m1" } },
      { name: "two", route: { provider: "b", model: "m2" } },
    ],
    threshold: 9,
    rounds: 2,
  });
  assert.equal(out.state, "partial");
  assert.equal(out.rounds.length, 2);
  assert.equal(out.final.overall, 7);
  assert.ok(out.final.findings.length >= 1);
  // Round 2 prompts carry the round-1 board.
  assert.match(seen[2], /Shared board after round 1/);
});

test("review fails closed without quorum and rejects writes", async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      return { result: { finalText: "no score block, just prose" }, route: request.route };
    },
  }));
  const out = await companion.review({
    request: reviewBase({ requestId: "review-quorum-test" }),
    reviewers: [
      { name: "one", route: { provider: "a", model: "m1" } },
      { name: "two", route: { provider: "b", model: "m2" } },
    ],
    rounds: 1,
  });
  assert.equal(out.state, "failed");
  await assert.rejects(companion.review({
    request: reviewBase({ requestId: "review-write-test", policy: { write: true } }),
    reviewers: [
      { name: "one", route: { provider: "a", model: "m1" } },
      { name: "two", route: { provider: "b", model: "m2" } },
    ],
  }), /must be read-only/);
  await assert.rejects(companion.review({
    request: reviewBase({ requestId: "review-dupe-test" }),
    reviewers: [
      { name: "one", route: { provider: "a", model: "m1" } },
      { name: "two", route: { provider: "a", model: "m1" } },
    ],
  }), /same route/);
});

test("previous loop context seeds round one", async (t) => {
  const seen = [];
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      seen.push(request.task);
      return { result: { finalText: block({ correctness: 10, security: 10, simplicity: 10 }, ["fixed"]) }, route: request.route };
    },
  }));
  const out = await companion.review({
    request: reviewBase({ requestId: "review-prev-test" }),
    reviewers: [
      { name: "one", route: { provider: "a", model: "m1" } },
      { name: "two", route: { provider: "b", model: "m2" } },
    ],
    rounds: 1,
    previous: { summary: "Fixed the auth leak; re-check.", scores: { overall: 6 } },
  });
  assert.equal(out.state, "completed");
  assert.match(seen[0], /Previous implement→review loop/);
  assert.match(seen[0], /Fixed the auth leak/);
});
