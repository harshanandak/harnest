import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeGraph } from "../src/graph-protocol.mjs";

const references = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "handoff", "references");

test("shipped workflow templates are valid graphs after placeholder substitution", async () => {
  const files = (await readdir(references)).filter((name) => /^workflow-.*\.json$/.test(name)).sort();
  assert.ok(files.length >= 5, `expected the documented template set, found ${files.length}`);
  for (const file of files) {
    const template = JSON.parse(await readFile(join(references, file), "utf8"));
    for (const node of template.nodes ?? []) {
      if (typeof node.cwd === "string" && node.cwd.startsWith("C:/replace")) node.cwd = process.cwd();
    }
    const spec = await normalizeGraph({ ...template, requestId: `template-${file}`, cwd: process.cwd() });
    assert.ok(spec.nodes.length >= 1, `${file} must declare at least one node`);
    assert.ok(spec.outputs.length >= 1, `${file} must select at least one output`);
    assert.equal(spec.requestId, `template-${file}`);
    for (const node of template.nodes ?? []) {
      if (node.target === "auto") assert.equal(node.route?.model, undefined, `${file}:${node.id} auto nodes must not pin a model`);
      if (node.policy?.write === true) assert.ok(node.cwd, `${file}:${node.id} writers need an isolated cwd`);
      if (node.context?.requiredText !== undefined) {
        assert.ok(Array.isArray(node.context.requiredText) && node.context.requiredText.every((value) => typeof value === "string" && value), `${file}:${node.id} requiredText must be non-empty strings`);
      }
      const task = typeof node.task === "string" ? node.task : "";
      assert.doesNotMatch(task, /upstream\.[A-Za-z0-9_-]+\.output\b/, `${file}:${node.id} upstream entries expose result, not output`);
      for (const match of task.matchAll(/upstream\.([A-Za-z0-9_-]+)\b/g)) {
        assert.ok((node.dependsOn ?? []).includes(match[1]), `${file}:${node.id} references upstream.${match[1]} without depending on it`);
      }
      for (const match of task.matchAll(/upstream\["([A-Za-z0-9_-]+)"\]/g)) {
        assert.ok((node.dependsOn ?? []).includes(match[1]), `${file}:${node.id} references upstream["${match[1]}"] without depending on it`);
      }
    }
    if (file.includes("quarantine")) {
      assert.equal(template.context?.backlog, undefined, "raw backlog must not be graph-level context (it merges into every node)");
      const readers = (template.nodes ?? []).filter((node) => String(node.id).startsWith("read-"));
      assert.ok(readers.length >= 2 && readers.every((node) => typeof node.context?.item === "string"), "each reader carries its own raw item context");
      const actor = (template.nodes ?? []).find((node) => node.id === "actor");
      assert.ok(actor, "quarantine template needs a trusted actor");
      assert.ok(!Object.keys(actor.context ?? {}).some((key) => ["item", "backlog", "tracked"].includes(key)), "actor must not receive raw or tracked context");
    }
  }
});
