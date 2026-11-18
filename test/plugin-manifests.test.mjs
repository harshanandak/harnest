// Plugin manifest hygiene: version stamps must carry the correct harness suffix
// and a 14-digit build date, and the Claude marketplace manifest must parse.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("claude plugin.json carries the package version and claude build stamp", async () => {
  const manifest = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.match(manifest.version, new RegExp(`^${escapedVersion}\\+claude\\.\\d{14}$`));
});

test("codex plugin.json carries the package version and codex build stamp", async () => {
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  assert.match(manifest.version, new RegExp(`^${escapedVersion}\\+codex\\.\\d{14}$`));
});

test("both stamps share the same build date", async () => {
  const claude = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const codex = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const dateOf = (v) => v.split(".").at(-1);
  assert.equal(dateOf(claude.version), dateOf(codex.version));
});

test(".claude-plugin/marketplace.json parses with the harnest entry", async () => {
  const marketplace = JSON.parse(await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugins = marketplace.plugins || [];
  assert.ok(plugins.some((p) => p.name === "harnest"), "harnest missing from marketplace");
  const claude = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugins.find((p) => p.name === "harnest").version, claude.version);
});
