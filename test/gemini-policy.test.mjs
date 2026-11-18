import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGeminiPolicyPreparer,
  GEMINI_CLI_VERSION,
  geminiSystemPoliciesDir,
  probeGeminiVersion,
} from "../src/adapters/gemini-policy.mjs";

class FakeChild extends EventEmitter {
  constructor({ stdout = "", stderr = "", code = 0 } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) this.stdout.emit("data", Buffer.from(stdout));
      if (stderr) this.stderr.emit("data", Buffer.from(stderr));
      this.emit("close", code, null);
    });
  }
  kill() { return true; }
}

function request(timeoutMs = 1000) {
  return { execution: { timeoutMs } };
}

test("Gemini isolated read-only policy writes the verified v0.62 settings and denies every tool outside the read allowlist", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "gemini-system-policy-empty-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  let probed = 0;
  const preparer = createGeminiPolicyPreparer({
    systemPoliciesDir,
    versionProbe: async () => { probed += 1; return GEMINI_CLI_VERSION; },
  });
  const prepared = await preparer.prepare({
    request: request(),
    policy: { write: false },
    cwd: process.cwd(),
    launch: { command: "fake-gemini", args: [] },
  });
  t.after(() => prepared.cleanup());

  assert.equal(probed, 1);
  assert.deepEqual(prepared.args.slice(0, 2), ["--approval-mode", "default"]);
  assert.ok(prepared.args.includes("--admin-policy"));
  assert.ok(prepared.args.includes("--policy"));
  assert.ok(prepared.args.includes("--extensions") && prepared.args.includes("none"));
  assert.ok(!prepared.args.some((value) => /yolo|auto_edit|plan/i.test(value)));
  assert.deepEqual(prepared.unsetEnv, ["GEMINI_CLI_IDE_WORKSPACE_PATH"]);

  const settings = JSON.parse(await readFile(prepared.paths.systemSettingsPath, "utf8"));
  assert.deepEqual(settings.security, {
    disableYoloMode: true,
    disableAlwaysAllow: true,
    enablePermanentToolApproval: false,
  });
  assert.equal(settings.hooksConfig.enabled, false);
  assert.deepEqual(settings.admin, {
    secureModeEnabled: true,
    extensions: { enabled: false },
    mcp: { enabled: false, config: {}, requiredConfig: {} },
    skills: { enabled: false },
  });
  assert.deepEqual(settings.tools.core, [
    "glob", "grep_search", "list_directory", "read_file", "read_many_files", "get_internal_docs", "google_web_search", "web_fetch",
  ]);
  assert.equal(settings.tools.discoveryCommand, "");
  assert.equal(settings.tools.callCommand, "");
  assert.equal(settings.mcp.serverCommand, "");
  assert.equal(settings.context.loadMemoryFromIncludeDirectories, false);
  assert.deepEqual(JSON.parse(await readFile(prepared.paths.systemDefaultsPath, "utf8")), {});

  const policy = await readFile(prepared.paths.adminPolicyPath, "utf8");
  for (const tool of settings.tools.core) assert.match(policy, new RegExp(`"${tool}"`));
  for (const forbidden of ["write_file", "replace", "run_shell_command", "exit_plan_mode", "invoke_agent"]) {
    assert.doesNotMatch(policy, new RegExp(`"${forbidden}"`));
  }
  assert.match(policy, /decision = "allow"[\s\S]*priority = 999[\s\S]*interactive = false/);
  assert.match(policy, /toolName = "\*"[\s\S]*decision = "deny"[\s\S]*priority = 998/);

  await prepared.cleanup();
  await assert.rejects(access(prepared.paths.root), (error) => error.code === "ENOENT");
});

test("Gemini isolated write policy admits only the verified ordinary coding additions", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "gemini-system-policy-write-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  const prepared = await createGeminiPolicyPreparer({
    systemPoliciesDir,
    versionProbe: async () => GEMINI_CLI_VERSION,
  }).prepare({
    request: request(),
    policy: { write: true },
    cwd: process.cwd(),
    launch: { command: "fake-gemini", args: [] },
  });
  t.after(() => prepared.cleanup());

  const settings = JSON.parse(await readFile(prepared.paths.systemSettingsPath, "utf8"));
  assert.deepEqual(settings.tools.core.slice(-3), ["write_file", "replace", "run_shell_command"]);
  const policy = await readFile(prepared.paths.adminPolicyPath, "utf8");
  for (const tool of ["write_file", "replace", "run_shell_command"]) assert.match(policy, new RegExp(`"${tool}"`));
  for (const forbidden of ["exit_plan_mode", "invoke_agent"]) assert.doesNotMatch(policy, new RegExp(`"${forbidden}"`));
  assert.equal(prepared.diagnostics.effectivePolicy.mode, "isolated-write-subset");
});

test("Gemini fails before policy materialization when an OS system TOML would disable invocation admin policy", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "gemini-system-policy-conflict-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  await writeFile(join(systemPoliciesDir, "enterprise.toml"), "[[rule]]\ntoolName='*'\ndecision='allow'\n", "utf8");
  const preparer = createGeminiPolicyPreparer({
    systemPoliciesDir,
    versionProbe: async () => GEMINI_CLI_VERSION,
  });
  await assert.rejects(
    preparer.prepare({ request: request(), policy: { write: false }, cwd: process.cwd(), launch: { command: "fake-gemini", args: [] } }),
    (error) => error.details?.kind === "policy" && error.details?.reason === "system-policy-conflict" && error.details?.count === 1,
  );
});

test("Gemini version preflight requires exact 0.62.0 before inference", async () => {
  const calls = [];
  const exact = await probeGeminiVersion({
    command: "fake-gemini",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: "0.62.0\n" });
    },
  });
  assert.equal(exact, GEMINI_CLI_VERSION);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.shell, false);

  await assert.rejects(
    probeGeminiVersion({ command: "fake-gemini", spawnFn() { return new FakeChild({ stdout: "0.63.0\n" }); } }),
    (error) => error.details?.kind === "unavailable"
      && error.details?.reason === "unsupported-version"
      && error.details?.observedVersion === "0.63.0",
  );
});

test("Gemini system policy paths match the native v0.62 platform constants", () => {
  assert.equal(geminiSystemPoliciesDir("win32"), "C:\\ProgramData\\gemini-cli\\policies");
  assert.equal(geminiSystemPoliciesDir("darwin"), "/Library/Application Support/GeminiCli/policies");
  assert.equal(geminiSystemPoliciesDir("linux"), "/etc/gemini-cli/policies");
});

test("Gemini probes the exact version only after isolated settings exist and with IDE workspace injection removed", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "gemini-system-policy-version-isolation-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  const key = "GEMINI_CLI_IDE_WORKSPACE_PATH";
  const saved = process.env[key];
  process.env[key] = "C:/outside-workspace";
  let observed;
  try {
    const prepared = await createGeminiPolicyPreparer({
      systemPoliciesDir,
      versionProbe: async (input) => {
        observed = input;
        const settings = JSON.parse(await readFile(input.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
        assert.equal(settings.admin.secureModeEnabled, true);
        assert.equal(input.env[key], undefined);
        assert.ok(input.signal instanceof AbortSignal);
        assert.ok(input.timeoutMs > 0 && input.timeoutMs <= 250);
        return GEMINI_CLI_VERSION;
      },
    }).prepare({
      request: request(250),
      policy: { write: false },
      cwd: process.cwd(),
      launch: { command: "fake-gemini", args: [] },
      signal: new AbortController().signal,
      timeoutMs: 250,
    });
    t.after(() => prepared.cleanup());
    assert.ok(observed.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH);
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("Gemini removes isolated files when version preflight fails after materialization", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "gemini-system-policy-version-cleanup-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  let settingsPath;
  await assert.rejects(
    createGeminiPolicyPreparer({
      systemPoliciesDir,
      versionProbe: async ({ env }) => {
        settingsPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
        await access(settingsPath);
        throw Object.assign(new Error("wrong version"), { details: { kind: "unavailable" } });
      },
    }).prepare({
      request: request(),
      policy: { write: false },
      cwd: process.cwd(),
      launch: { command: "fake-gemini", args: [] },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    }),
    (error) => error.details?.kind === "unavailable",
  );
  assert.ok(settingsPath, "version probe ran after settings materialization");
  await assert.rejects(access(settingsPath), (error) => error.code === "ENOENT");
});
