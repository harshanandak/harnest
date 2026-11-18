import assert from "node:assert/strict";
import test from "node:test";
import { modelIdentity, selectLatestModel } from "../src/model-selection.mjs";

const entry = (id, extra = {}) => ({ id, provider: "openai", thinking: ["low", "high"], ...extra });

test("latest follows a future release in the same family and tier without a version table", () => {
  const route = { provider: "openai", model: "gpt-5.6-sol", thinking: "high" };
  const catalog = { models: [entry("gpt-5.6-sol"), entry("gpt-6-sol"), entry("gpt-7-astra"), entry("gpt-6-sol", { provider: "other" })] };
  assert.deepEqual(selectLatestModel(route, catalog), { model: "gpt-6-sol", status: "updated" });
  catalog.models.push(entry("gpt-6.1-sol"));
  assert.equal(selectLatestModel(route, catalog).model, "gpt-6.1-sol");
  assert.equal(selectLatestModel({ ...route, model: "sol" }, catalog).model, "gpt-6.1-sol");
});

test("latest preserves verified free access and requested thinking", () => {
  const route = { provider: "opencode", model: "muse-spark-1.3-contributor-free", thinking: "high" };
  const model = (id, extra = {}) => entry(id, { provider: "opencode", cost: { input: 0, output: 0 }, ...extra });
  const catalog = { models: [
    model(route.model), model("muse-spark-1.4-contributor-free"),
    model("muse-spark-1.5-contributor-free", { cost: { input: 1, output: 2 } }),
    model("muse-spark-1.6-contributor-free", { thinking: ["low"] }),
    model("muse-spark-1.7-contributor-free", { cost: undefined }),
    model("muse-spark-2-contributor"),
  ] };
  assert.equal(selectLatestModel(route, catalog).model, "muse-spark-1.4-contributor-free");
});

test("unavailable, ambiguous and older catalogs never fabricate or downgrade a release", () => {
  const route = { model: "gpt-6-sol" };
  assert.equal(selectLatestModel(route, { reason: "offline" }).reason, "offline");
  assert.equal(selectLatestModel(route, { models: [entry("gpt-5.6-sol")] }).status, "unavailable");
  const ambiguous = { models: [entry("gpt-6-sol"), entry("gpt-6-sol", { provider: "other" })] };
  assert.equal(selectLatestModel({ model: "sol" }, ambiguous).status, "unavailable");
  assert.equal(selectLatestModel({ model: "gpt-6-sol" }, ambiguous).status, "unavailable");
  assert.equal(selectLatestModel({ model: "synthetic-model" }, { models: [] }).status, "untracked");
});

test("version identity preserves tiers, endpoint variants and snapshot ordering", () => {
  assert.equal(modelIdentity("claude-sonnet-4-5-20250929").family, modelIdentity("claude-sonnet-4-6").family);
  assert.notEqual(modelIdentity("deepseek-v4-flash").family, modelIdentity("deepseek-v5-pro").family);
  assert.notEqual(modelIdentity("gpt-5.6-sol").family, modelIdentity("gpt-6-sol-fast").family);
  assert.equal(selectLatestModel({ model: "claude-sonnet-4-5-20250929" }, { models: [entry("claude-sonnet-4-6")] }).model, "claude-sonnet-4-6");
});
