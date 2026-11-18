import assert from "node:assert/strict";
import test from "node:test";
import { LATEST, compareVersions, familyOf, freshnessReport, latestModel, versionOf } from "../src/model-families.mjs";

test("family detection covers tracked families and tiers", () => {
  assert.equal(familyOf("muse-spark-1.2-contributor"), "muse");
  assert.equal(familyOf("opencode-go/muse-spark-1.3"), "muse");
  assert.equal(familyOf("deepseek-v4-flash"), "deepseek-flash");
  assert.equal(familyOf("deepseek-v4.1-flash"), "deepseek-flash");
  assert.equal(familyOf("deepseek-v4-flash-free"), "deepseek-flash");
  assert.equal(familyOf("deepseek-v4-flash-0731"), "deepseek-flash");
  assert.equal(familyOf("deepseek-v4-flash-vision-exp"), "deepseek-vision");
  assert.equal(familyOf("deepseek-v4-pro"), "deepseek-pro");
  assert.equal(familyOf("gpt-5.6-luna"), null);
});

test("any tracked generation canonicalizes to the latest of its family", () => {
  assert.equal(latestModel("muse-spark-1.1-contributor"), LATEST.muse);
  assert.equal(latestModel("muse-spark-1.2"), LATEST.muse);
  assert.equal(latestModel("opencode-go/deepseek-v4-flash"), `opencode-go/${LATEST["deepseek-flash"]}`);
  assert.equal(latestModel("deepseek-v3-flash"), LATEST["deepseek-flash"]);
  assert.equal(latestModel("gpt-5.6-luna"), "gpt-5.6-luna", "untracked ids pass through");
});

test("version compare and freshness report detect newer generations", () => {
  assert.ok(compareVersions("muse-spark-1.4", "muse-spark-1.3") > 0);
  assert.equal(compareVersions([1, 3], [1, 3, 0]), 0);
  assert.deepEqual(versionOf("deepseek-v4.1-flash"), [4, 1]);
  const stale = freshnessReport("opencode-go/muse-spark-1.4-contributor\nopencode-go/deepseek-v4.1-flash\n");
  assert.equal(stale.current, false);
  assert.deepEqual(stale.updates, [
    { family: "muse", pinned: LATEST.muse, newest: "muse-spark-1.4-contributor" },
    { family: "deepseek-pro", pinned: LATEST["deepseek-pro"], newest: null, missing: true },
    { family: "deepseek-vision", pinned: LATEST["deepseek-vision"], newest: null, missing: true },
  ]);
  const current = freshnessReport("opencode-go/muse-spark-1.3-contributor\nopencode-go/deepseek-v4.1-flash\nopencode-go/deepseek-v4-pro\nopencode-go/deepseek-v4-flash-vision-exp\n");
  assert.equal(current.current, true, JSON.stringify(current.updates));
  const missing = freshnessReport("opencode-go/muse-spark-1.3-contributor\n");
  assert.equal(missing.current, false);
  assert.ok(missing.updates.every((update) => update.missing === true), JSON.stringify(missing.updates));
  assert.deepEqual(missing.updates.map((update) => update.family).sort(), ["deepseek-flash", "deepseek-pro", "deepseek-vision"]);
});
