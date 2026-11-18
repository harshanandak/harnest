import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRegistry } from "../src/workflow-registry.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-registry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const registry = new WorkflowRegistry({ userDir: join(cwd, "user"), validateScript: () => ({ meta: {} }) });
  return { cwd, registry };
}

test("saved revisions survive edit, deletion and a fresh registry", async (t) => {
  const { cwd, registry } = await fixture(t);
  const first = await registry.save({ cwd, name: "review", source: "return 1" });
  const second = await registry.save({ cwd, name: "review", source: "return 2", expectedRevision: first.revision });
  const fresh = new WorkflowRegistry();
  assert.equal((await fresh.get({ cwd, name: "review", scope: "project" })).source, "return 2");
  await registry.delete({ cwd, name: "review", expectedRevision: second.revision });
  await assert.rejects(fresh.get({ cwd, name: "review", scope: "project" }), { details: { kind: "not-found" } });
  assert.equal((await fresh.get({ cwd, name: "review", revision: first.revision })).source, "return 1");
  assert.deepEqual((await registry.list({ cwd })).workflows, []);
});

test("concurrent replacements permit exactly one winner", async (t) => {
  const { cwd, registry } = await fixture(t);
  const saved = await registry.save({ cwd, name: "review", source: "return 0" });
  const attempts = await Promise.allSettled([1, 2].map((n) => registry.save({ cwd, name: "review", source: `return ${n}`, expectedRevision: saved.revision })));
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  assert.equal(attempts.find((a) => a.status === "rejected").reason.details.kind, "conflict");
});

test("project precedence and paginated listing avoid copying source", async (t) => {
  const { cwd, registry } = await fixture(t);
  await registry.save({ cwd, scope: "user", name: "review", source: "return 1" });
  await registry.save({ cwd, name: "review", source: "return 2" });
  await registry.save({ cwd, name: "audit", source: "return 3" });
  assert.equal((await registry.get({ cwd, name: "review" })).source, "return 2");
  const page = await registry.list({ cwd, limit: 1 });
  assert.equal(page.workflows[0].name, "audit");
  assert.equal(page.workflows[0].source, undefined);
  const next = await registry.list({ cwd, limit: 1, cursor: page.nextCursor });
  assert.equal(next.workflows[0].scope, "project");
  assert.equal(next.nextCursor, null);
});

test("invalid names and corrupt revision bytes fail closed", async (t) => {
  const { cwd, registry } = await fixture(t);
  await assert.rejects(registry.save({ cwd, name: "../escape", source: "return 1" }), { details: { kind: "validation" } });
  const saved = await registry.save({ cwd, name: "review", source: "return 1" });
  await writeFile(join(registry.directory("project", cwd), `${registry.key("review")}.${saved.revision}.js`), "return 2");
  await assert.rejects(registry.get({ cwd, name: "review" }), { details: { kind: "persistence" } });
});

test("historical source reads return metadata from that revision", async (t) => {
  const { cwd } = await fixture(t);
  const registry = new WorkflowRegistry({ userDir: join(cwd, "actual-user") });
  const first = await registry.save({ cwd, name: "review", source: 'export const meta = { name: "review", description: "first" }; return 1;' });
  await registry.save({ cwd, name: "review", expectedRevision: first.revision, source: 'export const meta = { name: "review", description: "second" }; return 2;' });
  assert.equal((await registry.get({ cwd, name: "review", revision: first.revision })).description, "first");
  assert.equal((await registry.list({ cwd })).workflows[0].description, "second");
});

test("deleted definitions can be recreated and every source revision can be discovered", async (t) => {
  const { cwd, registry } = await fixture(t);
  const first = await registry.save({ cwd, name: "review", source: "return 1" });
  await registry.delete({ cwd, name: "review", expectedRevision: first.revision });
  const second = await registry.save({ cwd, name: "review", source: "return 2" });
  const page = await registry.revisions({ cwd, name: "review", limit: 1 });
  const next = await registry.revisions({ cwd, name: "review", limit: 1, cursor: page.nextCursor });
  assert.deepEqual([...page.revisions, ...next.revisions].map((r) => r.revision).sort(), [first.revision, second.revision].sort());
  assert.equal(next.nextCursor, null);
  await assert.rejects(registry.get({ cwd, name: "review", revision: "f".repeat(64) }), { details: { kind: "not-found" } });
});

test("pinned revision falls through scopes and corrupt indexes report separately", async (t) => {
  const { cwd, registry } = await fixture(t);
  const user = await registry.save({ cwd, name: "review", scope: "user", source: "return 1" });
  await registry.save({ cwd, name: "review", source: "return 2" });
  assert.equal((await registry.get({ cwd, name: "review", revision: user.revision })).scope, "user");
  await writeFile(join(registry.directory("project", cwd), `${"a".repeat(64)}.json`), "broken");
  const page = await registry.list({ cwd });
  assert.equal(page.workflows.length, 1);
  assert.equal(page.errors.length, 1);
});

test("operations without a project directory consistently default to user scope", async (t) => {
  const { registry } = await fixture(t);
  const saved = await registry.save({ name: "personal", source: "return 1" });
  assert.equal(saved.scope, "user");
  assert.equal((await registry.list()).workflows[0].name, "personal");
  assert.equal((await registry.get({ name: "personal" })).revision, saved.revision);
  assert.equal((await registry.revisions({ name: "personal" })).revisions[0].revision, saved.revision);
  await registry.delete({ name: "personal", expectedRevision: saved.revision });
  assert.equal((await registry.list()).workflows.length, 0);
  await assert.rejects(registry.save({ name: "project", source: "return 1", scope: "project" }), /project scope requires cwd/);
});
