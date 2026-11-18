// Model freshness: stale snapshots never bless old pins.
import assert from "node:assert/strict";
import test from "node:test";
import { comparePins, isSnapshotFresh, SNAPSHOT_TTL_MS } from "../src/model-freshness.mjs";

const NOW = Date.parse("2026-09-11T12:00:00Z");

function snapshot(at, models) {
  return { at, harnesses: { cursor: { models } } };
}

test("fresh snapshot verifies pins against the live list", () => {
  const snap = snapshot(new Date(NOW - 3600000).toISOString(), ["composer-2.5 - Composer", "cursor-grok-4.6-high-fast - Grok"]);
  assert.equal(isSnapshotFresh(snap, NOW), true);
  assert.deepEqual(comparePins({ cursor: "composer-2.5" }, snap, NOW), []);
  assert.equal(comparePins({ cursor: "gpt-5.2" }, snap, NOW).length, 1);
  assert.match(comparePins({ cursor: "gpt-5.2" }, snap, NOW)[0].reason, /not in the live/);
});

test("full display names match by id prefix", () => {
  const snap = snapshot(new Date(NOW - 1000).toISOString(), ["cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast"]);
  assert.deepEqual(comparePins({ cursor: "cursor-grok-4.6-high-fast" }, snap, NOW), []);
});

test("snapshots older than 24h are unknown, never permission", () => {
  const stale = snapshot(new Date(NOW - SNAPSHOT_TTL_MS - 1000).toISOString(), ["composer-2.5"]);
  assert.equal(isSnapshotFresh(stale, NOW), false);
  const warnings = comparePins({ cursor: "composer-2.5" }, stale, NOW);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].reason, /older than 24h/);
});

test("missing snapshot warns only when pins exist", () => {
  assert.deepEqual(comparePins({}, null, NOW), []);
  assert.equal(comparePins({ cursor: "composer-2.5" }, null, NOW).length, 1);
});

test("unknown harness entries are skipped, not failed", () => {
  const snap = { at: new Date(NOW - 1000).toISOString(), harnesses: { cursor: { unknown: "probe failed" } } };
  assert.deepEqual(comparePins({ cursor: "anything" }, snap, NOW), []);
});

test("managed entries without a probed list are skipped, not warned", () => {
  const snap = {
    at: new Date(NOW - 1000).toISOString(),
    harnesses: {
      cursor: { models: ["composer-2.5"] },
      claude: { managed: "aliases resolve server-side" },
    },
  };
  assert.deepEqual(comparePins({ claude: "sonnet" }, snap, NOW), []);
  assert.deepEqual(comparePins({ cursor: "composer-2.5" }, snap, NOW), []);
});
