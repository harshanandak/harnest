import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findAmpProjectCustomization, prepareAmpPolicy } from "../src/adapters/amp-policy.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harnest-amp-policy-test-"));
  await writeFile(join(root, ".git"), "gitdir: ignored\n");
  const cwd = join(root, "nested");
  await mkdir(cwd);
  return { root, cwd };
}

test("Amp policy writes a private temporary risk-reduction profile and removes it", async () => {
  const { root, cwd } = await fixture();
  try {
    const prepared = await prepareAmpPolicy({
      cwd,
      request: { policy: { write: true } },
      env: {},
    });
    const settingsPath = prepared.args[1];
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(prepared.args[0], "--settings-file");
    assert.equal(settings["amp.dangerouslyAllowAll"], false);
    assert.equal(settings["amp.updates.mode"], "disabled");
    assert.equal(settings["amp.remoteThreadCreation.enabled"], false);
    assert.equal(settings["amp.runner.env.enabled"], false);
    assert.equal(settings["amp.skills.disableClaudeCodeSkills"], true);
    assert.equal(settings["amp.skills.disableGlobalAgentsSkills"], true);
    assert.deepEqual(settings["amp.mcpPermissions"], [
      { matches: { command: "*" }, action: "reject" },
      { matches: { url: "*" }, action: "reject" },
    ]);
    assert.equal(prepared.env.AMP_SETTINGS_FILE, settingsPath);
    assert.equal(prepared.env.AMP_SKIP_UPDATE_CHECK, "1");
    assert.equal(prepared.diagnostics.effectivePolicy.isolation, "best-effort-native-settings");
    assert.match(prepared.diagnostics.limitations.join(" "), /do not contain personal or workspace plugins/);
    await prepared.cleanup();
    await assert.rejects(access(settingsPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Amp policy rejects detectable project settings and plugins without opening them", async () => {
  for (const relative of ["settings.json", "plugins"]) {
    const { root, cwd } = await fixture();
    try {
      const target = join(root, ".amp", relative);
      if (relative.includes(".")) {
        await mkdir(join(root, ".amp"));
        await writeFile(target, "not inspected");
      } else {
        await mkdir(target, { recursive: true });
      }
      assert.deepEqual(await findAmpProjectCustomization(cwd), { root, relative: `.amp/${relative}` });
      await assert.rejects(
        prepareAmpPolicy({ cwd, request: { policy: { write: true } }, env: {} }),
        (error) => error.details?.kind === "policy" && error.details?.reason === "project-customization",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Amp policy rejects external toolboxes and read-only requests before creating settings", async () => {
  const { root, cwd } = await fixture();
  try {
    await assert.rejects(
      prepareAmpPolicy({ cwd, request: { policy: { write: true } }, env: { AMP_TOOLBOX: "/external/tools" } }),
      (error) => error.details?.reason === "external-toolbox",
    );
    await assert.rejects(
      prepareAmpPolicy({ cwd, request: { policy: { write: false } }, env: {} }),
      (error) => error.details?.reason === "read-only-unenforceable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Amp policy fails closed when project customization inspection is unreadable", async () => {
  const { root, cwd } = await fixture();
  try {
    const failure = Object.assign(new Error("access denied"), { code: "EACCES" });
    await assert.rejects(
      prepareAmpPolicy({
        cwd,
        request: { policy: { write: true } },
        env: {},
        inspectCustomization: async () => { throw failure; },
      }),
      (error) => error.details?.kind === "policy" && error.details?.reason === "customization-inspection-failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
