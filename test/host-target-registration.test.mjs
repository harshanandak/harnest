import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const codexWorkers = ["acp_worker.toml", "amp_worker.toml", "claude_worker.toml", "cursor_worker.toml", "gemini_worker.toml", "opencode_worker.toml", "pi_worker.toml"];

test("native Codex installer copies every supported external worker into an isolated project", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-native-agents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await exec("powershell.exe", ["-NoProfile", "-File", join(root, "scripts", "install-native-agents.ps1"), "-Project"], { cwd: directory });
  assert.deepEqual((await readdir(join(directory, ".codex", "agents"))).sort(), codexWorkers);
});

test("native Codex installer uses CODEX_HOME for personal workers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-native-home-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, "custom codex home");
  const options = { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, CODEX_HOME: codexHome } };
  if (process.platform === "win32") {
    await exec("powershell.exe", ["-NoProfile", "-File", join(root, "scripts", "install-native-agents.ps1")], options);
  } else {
    await exec("bash", [join(root, "scripts", "install-native-agents.sh")], options);
  }
  assert.deepEqual((await readdir(join(codexHome, "agents"))).sort(), codexWorkers);
});

test("native Codex installers preserve customized and removed worker bytes and skip identical files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-worker-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, "custom codex home");
  const agents = join(codexHome, "agents");
  await mkdir(agents, { recursive: true });
  const custom = "acp_worker.toml";
  const removed = "dsh_worker.toml";
  const identical = "claude_worker.toml";
  const customizedBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0xff, 0x0d, 0x0a]);
  const obsoleteBytes = Buffer.from("# obsolete local customization\r\n");
  await writeFile(join(agents, custom), customizedBytes);
  await writeFile(join(agents, removed), obsoleteBytes);
  await writeFile(join(agents, identical), await readFile(join(root, "codex-agents", identical)));
  await utimes(join(agents, identical), 1_700_000_000, 1_700_000_000);
  const originalMtime = (await stat(join(agents, identical))).mtimeMs;
  const options = { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, CODEX_HOME: codexHome } };
  const run = () => process.platform === "win32"
    ? exec("powershell.exe", ["-NoProfile", "-File", join(root, "scripts", "install-native-agents.ps1")], options)
    : exec("bash", [join(root, "scripts", "install-native-agents.sh")], options);
  const { stdout } = await run();
  const items = await readdir(agents);
  for (const [name, original] of [[custom, customizedBytes], [removed, obsoleteBytes]]) {
    const file = items.find((entry) => entry.startsWith(name + ".bak-harnest-"));
    assert.ok(file, "missing worker backup for " + name);
    const backup = join(agents, file);
    assert.ok(stdout.includes(backup), "installer must print the backup path");
    assert.match(stdout, /--restore/);
    assert.deepEqual(await readFile(backup), original);
  }
  assert.equal((await stat(join(agents, identical))).mtimeMs, originalMtime);
  assert.deepEqual(await readFile(join(agents, custom)), await readFile(join(root, "codex-agents", custom)));
  await assert.rejects(stat(join(agents, removed)), { code: "ENOENT" });
  await run();
  assert.deepEqual((await readdir(agents)).sort(), items.sort(), "reinstall must not make additional backups");
  for (const [name, original] of [[custom, customizedBytes], [removed, obsoleteBytes]]) {
    const backup = join(agents, items.find((entry) => entry.startsWith(name + ".bak-harnest-")));
    await exec(process.execPath, [join(root, "scripts", "install-host-config.mjs"), "--restore", backup], options);
    assert.deepEqual(await readFile(join(agents, name)), original);
  }
});

test("doctor registers Gemini and Amp launch probes without model calls", async () => {
  const source = await readFile(join(root, "scripts", "doctor.mjs"), "utf8");
  for (const target of ["gemini", "amp"]) {
    assert.match(source, new RegExp(`${target}: resolveLaunch\\(\"${target}\"\\)`));
    assert.match(source, new RegExp(`${target}: await describeLaunch\\(resolved\\.${target}\\)`));
  }
});

test("doctor reports ACP registration metadata without launching an ACP executable", async () => {
  const source = await readFile(join(root, "scripts", "doctor.mjs"), "utf8");
  assert.match(source, /listConfiguredAcpAgents/);
  assert.doesNotMatch(source, /resolveLaunch\("acp"\)|describeLaunch\(resolved\.acp/);
  assert.match(source, /acp-agent:/);
});

test("Claude hook matchers register every optional worker bridge", async () => {
  const hooks = JSON.parse(await readFile(join(root, "hooks", "hooks.json"), "utf8"));
  for (const event of ["SubagentStart", "SubagentStop"]) {
    const matcher = hooks.hooks[event][0].matcher;
    assert.match(matcher, /gemini-worker/);
    assert.match(matcher, /amp-worker/);
    assert.match(matcher, /acp-worker/);
  }
});

test("public host guidance exposes the complete generic ACP contract", async () => {
  const skill = await readFile(join(root, "skills", "handoff", "SKILL.md"), "utf8");
  assert.match(skill, /Launch the handoff.*harnest:acp-worker/);
  assert.match(skill, /On Codex.*acp_worker/);
  assert.match(skill, /On OpenCode.*acp-worker/);
  assert.match(skill, /Downstream .*registered ACP agents.*own supported credentials/);
  assert.match(skill, /Read-only review:.*generic ACP reject[s]? read-only/i);
  assert.match(skill, /Fix in place:.*generic ACP requires.*route\.agent.*writeApproved/i);

  const liveTranscript = await readFile(join(root, "docs", "live-transcript.md"), "utf8");
  assert.match(liveTranscript, /Bridge workers \([^)]*acp-worker/);

  for (const path of ["README.md", join("docs", "public-installation.md")]) {
    const document = await readFile(join(root, path), "utf8");
    assert.match(document, /Gemini, Amp, and generic ACP.*native-session.*reject session transport and live controls/);
  }

  const architecture = await readFile(join(root, "docs", "architecture.md"), "utf8");
  assert.match(architecture, /ACP adapter.*registered ACP agent/);
  assert.match(architecture, /individual handoff.*`acp`/);
});

test("command discovery and project guidance expose generic ACP honestly", async () => {
  const workflow = await readFile(join(root, "commands", "handoff-workflow.md"), "utf8");
  assert.match(workflow, /target=opencode\|pi\|cursor\|claude\|codex\|gemini\|amp\|acp/);
  assert.match(workflow, /generic ACP/i);
  assert.match(workflow, /trusted.*route\.agent/i);
  assert.match(workflow, /policy\.write=true/);
  assert.match(workflow, /metadata\.harnest\.writeApproved=true/);
  assert.match(workflow, /rejects.*live controls/i);

  for (const command of ["handoff-fleet.md", "handoff-sessions.md"]) {
    const raw = await readFile(join(root, "commands", command), "utf8");
    assert.match(raw, /target=opencode\|pi\|cursor\|claude\|codex\|gemini\|amp\|acp/);
    assert.match(raw, /generic ACP/i);
    assert.match(raw, /resume.*execution\.sessionId/i);
    assert.match(raw, /rejects live.*control/i);
  }

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /`acp_worker`/);
});
