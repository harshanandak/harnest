import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OFFICIAL_ACP_REGISTRY_URL,
  describeRegistryAgent,
  fetchOfficialRegistry,
  listRegistryAgents,
  registerAcpAgent,
} from "../scripts/acp-registry.mjs";

const document = {
  version: "1.0.0",
  agents: [{
    id: "fixture-agent",
    name: "Fixture Agent",
    version: "2.3.4",
    description: "Fixture metadata",
    distribution: {
      npx: { package: "untrusted-package", args: ["--acp"], env: { SECRET: "value" } },
    },
  }],
};

test("the registry helper fetches only the official bounded JSON metadata document", async () => {
  const seen = [];
  const registry = await fetchOfficialRegistry({
    fetchFn: async (url, options) => {
      seen.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json", "content-length": String(JSON.stringify(document).length) }),
        text: async () => JSON.stringify(document),
      };
    },
  });
  assert.equal(seen[0].url, OFFICIAL_ACP_REGISTRY_URL);
  assert.equal(seen[0].options.redirect, "error");
  assert.equal(registry.version, "1.0.0");
  assert.deepEqual(listRegistryAgents(registry), [{ id: "fixture-agent", name: "Fixture Agent", version: "2.3.4", description: "Fixture metadata" }]);
  assert.deepEqual(describeRegistryAgent(registry, "fixture-agent"), listRegistryAgents(registry)[0]);
});

test("registry responses fail closed when oversized or structurally invalid", async () => {
  await assert.rejects(fetchOfficialRegistry({
    maxBytes: 10,
    fetchFn: async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": "11" }), text: async () => "{}" }),
  }), /too large/i);
  await assert.rejects(fetchOfficialRegistry({
    fetchFn: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ version: "1", agents: [{ id: "bad id" }] }) }),
  }), /invalid/i);
  await assert.rejects(fetchOfficialRegistry({
    fetchFn: async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), text: async () => JSON.stringify(document) }),
  }), /content type is not JSON/i);

  let cancelled = false;
  let index = 0;
  const chunks = [Buffer.from('{"version":"1","agents":['), Buffer.alloc(20, 97)];
  await assert.rejects(fetchOfficialRegistry({
    maxBytes: 30,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
          cancel: async () => { cancelled = true; },
        }),
      },
    }),
  }), /too large/i);
  assert.equal(cancelled, true, "the bounded reader cancels a chunked oversized response");
});

test("register stores only an explicitly supplied trusted native launch and preserves config keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acp-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "harnest.config.local.json");
  await writeFile(configPath, JSON.stringify({ keep: { value: 1 }, acp: { keepToo: true, agents: { existing: { command: "existing", args: [], trusted: true } } } }), "utf8");

  const saved = await registerAcpAgent({
    registry: document,
    agentId: "fixture-agent",
    command: process.execPath,
    args: ["acp", "serve"],
    trust: true,
    configPath,
  });
  assert.deepEqual(saved, {
    id: "fixture-agent",
    command: process.execPath,
    args: ["acp", "serve"],
    trusted: true,
    registryId: "fixture-agent",
    version: "2.3.4",
  });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.keep, { value: 1 });
  assert.equal(config.acp.keepToo, true);
  assert.deepEqual(config.acp.agents.existing, { command: "existing", args: [], trusted: true });
  assert.deepEqual(config.acp.agents["fixture-agent"], {
    command: process.execPath,
    args: ["acp", "serve"],
    trusted: true,
    registryId: "fixture-agent",
    version: "2.3.4",
  });
  assert.doesNotMatch(JSON.stringify(config), /untrusted-package|"SECRET"/);
});

test("register never trusts metadata launch commands or implicit consent", async () => {
  await assert.rejects(registerAcpAgent({ registry: document, agentId: "fixture-agent", command: "native", args: [], trust: false }), /--trust/i);
  await assert.rejects(registerAcpAgent({ registry: document, agentId: "fixture-agent", args: [], trust: true }), /--command/i);
  await assert.rejects(registerAcpAgent({ registry: document, agentId: "missing", command: "native", args: [], trust: true }), /not found/i);
  await assert.rejects(registerAcpAgent({ registry: document, agentId: "fixture-agent", command: "native", args: [], trust: true, protocolVersion: 3 }), /protocol-version must be 1 or 2/i);
});

test("register rejects malformed existing local config instead of replacing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acp-registry-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "harnest.config.local.json");
  for (const [contents, pattern] of [
    ["{secret parse excerpt", /invalid JSON/i],
    [JSON.stringify({ acp: [] }), /acp must be an object/i],
    [JSON.stringify({ acp: { agents: [] } }), /acp\.agents must be an object/i],
  ]) {
    await writeFile(configPath, contents, "utf8");
    await assert.rejects(registerAcpAgent({ registry: document, agentId: "fixture-agent", command: process.execPath, args: [], trust: true, configPath }), pattern);
  }
});
