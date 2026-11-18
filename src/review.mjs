// Multi-model review: N independent lanes score the same work against a
// shared rubric, see each other's findings, answer each other directly, and
// re-score. Pure functions (prompt building, score-block parsing, tallying,
// consolidation); orchestration lives in Companion.review.
//
// One call = up to `rounds` of opinion-convergence. It never implements:
// the caller applies the consolidated findings, then re-invokes with
// `previous` for the next implement→review loop. Reviews are read-only;
// write-capable review input is rejected like handoff_compare.
import { randomUUID } from "node:crypto";

export const REVIEW_MIN_LANES = 2;
export const REVIEW_MAX_LANES = 8;
export const REVIEW_MIN_ROUNDS = 1;
export const REVIEW_MAX_ROUNDS = 3;
export const REVIEW_DEFAULT_THRESHOLD = 9;
export const REVIEW_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function normalizeRubric(input) {
  if (!Array.isArray(input) || !input.length) {
    throw Object.assign(new TypeError("review rubric must be a non-empty array of { factor, weight? }"), { details: { kind: "validation" } });
  }
  const seen = new Set();
  return input.map((entry, index) => {
    const factor = typeof entry === "string" ? entry : entry?.factor;
    if (typeof factor !== "string" || !factor.trim()) {
      throw Object.assign(new TypeError(`review rubric[${index}] needs a non-empty factor name`), { details: { kind: "validation" } });
    }
    const name = factor.trim();
    if (seen.has(name)) throw Object.assign(new TypeError(`duplicate rubric factor: ${name}`), { details: { kind: "validation" } });
    seen.add(name);
    const weight = entry && typeof entry === "object" && entry.weight !== undefined ? entry.weight : 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw Object.assign(new TypeError(`review rubric factor ${name} needs a positive weight`), { details: { kind: "validation" } });
    }
    return { factor: name, weight };
  });
}

export function normalizeReviewers(input) {
  if (!Array.isArray(input) || input.length < REVIEW_MIN_LANES || input.length > REVIEW_MAX_LANES) {
    throw Object.assign(new TypeError(`review requires ${REVIEW_MIN_LANES} to ${REVIEW_MAX_LANES} reviewers`), { details: { kind: "validation" } });
  }
  const names = new Set();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw Object.assign(new TypeError("each reviewer must be an object"), { details: { kind: "validation" } });
    }
    if (typeof candidate.name !== "string" || !REVIEW_NAME_PATTERN.test(candidate.name)) {
      throw Object.assign(new TypeError("reviewer.name must use letters, numbers, dot, underscore, or hyphen"), { details: { kind: "validation" } });
    }
    if (names.has(candidate.name)) throw Object.assign(new TypeError(`duplicate reviewer: ${candidate.name}`), { details: { kind: "validation" } });
    names.add(candidate.name);
    if (!candidate.route || typeof candidate.route !== "object" || Array.isArray(candidate.route)) {
      throw Object.assign(new TypeError(`reviewer ${candidate.name} requires a route object`), { details: { kind: "validation" } });
    }
    if (typeof candidate.route.model !== "string" || !candidate.route.model.trim()) {
      throw Object.assign(new TypeError(`reviewer ${candidate.name} requires route.model`), { details: { kind: "validation" } });
    }
  }
  return input;
}

export function reviewPrompt({ task, context, rubric, round, board, lane, previous }) {
  const factors = rubric.map((r) => `- ${r.factor} (weight ${r.weight})`).join("\n");
  const lines = [
    `You are reviewer "${lane}" in a multi-model review panel. Review ONLY; do not edit, implement, or fix anything.`,
    "",
    "## Work under review",
    task,
  ];
  if (context != null) lines.push("", "## Context", typeof context === "string" ? context : JSON.stringify(context, null, 2).slice(0, 8000));
  lines.push("", "## Rubric (score each factor 0-10, integers)", factors);
  if (previous?.summary) {
    lines.push("", "## Previous implement→review loop", String(previous.summary).slice(0, 4000));
    if (previous.scores && typeof previous.scores === "object") {
      lines.push(`Prior overall: ${JSON.stringify(previous.scores).slice(0, 1000)}`);
    }
    lines.push("Confirm what was addressed, restate what was not, and score the CURRENT state only.");
  }
  if (round > 1 && board) {
    lines.push("", `## Shared board after round ${round - 1} (all lanes saw this)`);
    for (const entry of board.lanes) {
      lines.push(`### ${entry.name} — overall ${entry.scoreText}`);
      for (const finding of entry.findings.slice(0, 20)) lines.push(`- ${finding}`);
    }
    const toMe = (board.messages || []).filter((m) => m.to === lane);
    if (toMe.length) {
      lines.push("", `## Directed at you (${lane}) — answer each point`);
      for (const message of toMe.slice(0, 10)) lines.push(`- from ${message.from}: ${message.message}`);
    }
    const open = (board.messages || []).filter((m) => m.to !== lane).slice(0, 10);
    if (open.length) {
      lines.push("", "## Open messages between other lanes (context, may concern you)");
      for (const message of open) lines.push(`- ${message.from} → ${message.to}: ${message.message}`);
    }
    lines.push("", "Re-review in light of the board. Confirm fixed findings, add new ones, update every factor score.");
  }
  lines.push(
    "",
    "## Output contract (mandatory — a missing or malformed block abstains your lane)",
    "End your response with exactly one fenced block and nothing after it:",
    "```json",
    '{"scores": {"<factor>": 0-10, ...}, "findings": ["...", ...], "to": [{"lane": "<other-lane>", "message": "..."}]}',
    "```",
    "Cover EVERY rubric factor. Address other lanes through \"to\" (by name) to dispute, confirm, or ask; they will see it next round.",
  );
  return lines.join("\n");
}

function extractJsonBlock(text) {
  const matches = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!matches.length) return { error: "no fenced ```json score block found" };
  try {
    return { value: JSON.parse(matches.at(-1)[1]) };
  } catch (error) {
    return { error: `score block is not valid JSON: ${error.message}` };
  }
}

export function parseLaneResult(name, finalText, rubric) {
  const factors = new Set(rubric.map((r) => r.factor));
  const { value, error } = extractJsonBlock(finalText);
  if (error) return { name, valid: false, error };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name, valid: false, error: "score block must be a JSON object" };
  }
  const scores = value.scores && typeof value.scores === "object" && !Array.isArray(value.scores) ? value.scores : null;
  if (!scores) return { name, valid: false, error: "score block needs a scores object" };
  for (const factor of factors) {
    const score = scores[factor];
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      return { name, valid: false, error: `factor ${factor} needs a number 0-10` };
    }
  }
  const findings = Array.isArray(value.findings)
    ? value.findings.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()).slice(0, 50)
    : [];
  const to = Array.isArray(value.to)
    ? value.to.filter((m) => m && typeof m.lane === "string" && typeof m.message === "string")
      .map((m) => ({ from: name, to: m.lane.trim(), message: m.message.trim() })).filter((m) => m.to && m.message).slice(0, 20)
    : [];
  return { name, valid: true, scores, findings, to };
}

export function tallyRound(parsed, rubric) {
  const voting = parsed.filter((lane) => lane.valid);
  const weights = Object.fromEntries(rubric.map((r) => [r.factor, r.weight]));
  const laneScores = voting.map((lane) => {
    let weighted = 0;
    let total = 0;
    for (const { factor, weight } of rubric) {
      weighted += lane.scores[factor] * weight;
      total += weight;
    }
    return { name: lane.name, score: weighted / total };
  });
  const factorMeans = Object.fromEntries(rubric.map(({ factor }) => [
    factor,
    voting.length ? voting.reduce((sum, lane) => sum + lane.scores[factor], 0) / voting.length : null,
  ]));
  const overall = laneScores.length
    ? laneScores.reduce((sum, lane) => sum + lane.score, 0) / laneScores.length
    : null;
  return { voting: voting.map((lane) => lane.name), abstained: parsed.filter((lane) => !lane.valid).map((lane) => ({ name: lane.name, error: lane.error })), laneScores, factorMeans, overall };
}

export function boardView(parsed, tally) {
  const scores = Object.fromEntries((tally?.laneScores || []).map((lane) => [lane.name, lane.score]));
  return {
    lanes: parsed.map((lane) => ({
      name: lane.name,
      scoreText: lane.valid
        ? String(Math.round(scores[lane.name] * 10) / 10)
        : `abstained (${lane.error})`,
      findings: lane.valid ? lane.findings : [],
    })),
    messages: parsed.flatMap((lane) => lane.valid ? lane.to : []),
  };
}

export function consolidateFindings(parsed) {
  const seen = new Set();
  const findings = [];
  for (const lane of parsed) {
    if (!lane.valid) continue;
    for (const finding of lane.findings) {
      const key = finding.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ lane: lane.name, finding });
    }
  }
  return findings;
}

export function reviewId(base, nonce, lane, round) {
  return `${base}:review:${nonce}:${lane}:r${round}`;
}

export function newReviewNonce() {
  return randomUUID().split("-")[0];
}
