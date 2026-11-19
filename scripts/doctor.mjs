import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { harnessLaunch, readLocalConfig } from "../src/config.mjs";
import { runProcess } from "../src/process.mjs";
import { validateRoutingConfiguration } from "../src/routing.mjs";
import { listConfiguredAcpAgents } from "../src/acp-registry.mjs";
import { daemonStatus } from "../src/daemon-client.mjs";
import { checkLeadConnections, doctorHosts } from "./doctor-hosts.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const leadOptions = {};
const leadFlags = { "--host": "host", "--project": "project", "--config": "configPath" };
const args = process.argv.slice(2);
const usage = "Usage: bun run doctor [--host " + [...doctorHosts, "other"].join("|") + "] [--project DIR] [--config FILE]";
if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(usage); process.exit(0); }
for (let index = 0; index < args.length; index += 2) {
  const option = leadFlags[args[index]];
  const value = args[index + 1];
  if (!option || !value || value.startsWith("--")) throw new Error(usage);
  leadOptions[option] = option === "host" ? value : resolve(value);
}
if (!leadOptions.host || leadOptions.host === "gemini") {
  process.stdout.write("Legacy Gemini target. Gemini CLI now serves only paid Gemini API keys and enterprise Code Assist. Personal Google accounts should use the antigravity ACP preset.\n");
}
if (!await checkLeadConnections(leadOptions)) process.exitCode = 1;
if (leadOptions.host) process.exit(process.exitCode ?? 0);
const daemon = await daemonStatus().catch(() => ({ ready: false, version: null }));
process.stdout.write(`transport: shared Streamable HTTP (stdio bridge and standalone legacy available)\ndaemon: ${daemon.ready ? `ready version=${daemon.version}` : "unavailable"}\n`);

async function version(command, args = ["--version"], timeoutMs = 15_000) {
  try {
    const { stdout, stderr } = await runProcess(command, args, { timeoutMs });
    return (stdout || stderr).trim().split(/\r?\n/)[0];
  } catch (error) {
    return `unavailable (${error.code || error.message})`;
  }
}

const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
const resolveLaunch = (target) => {
  try {
    return { ok: true, launch: harnessLaunch(target) };
  } catch (error) {
    return { ok: false, error };
  }
};
const resolved = {
  opencode: resolveLaunch("opencode"),
  pi: resolveLaunch("pi"),
  cursor: resolveLaunch("cursor"),
  claude: resolveLaunch("claude"),
  codex: resolveLaunch("codex"),
  gemini: resolveLaunch("gemini"),
  amp: resolveLaunch("amp"),
};
const describeLaunch = async (entry, args = ["--version"], timeoutMs = 15_000) => entry.ok
  ? `${await version(entry.launch.command, [...(entry.launch.args || []), ...args], timeoutMs)} (${entry.launch.command}${entry.launch.fallbackFrom ? `; fell back from ${entry.launch.fallbackFrom}, missing ${entry.launch.missing}` : ""})`
  : `MISSING (${entry.error.message})`;
const checks = {
  plugin: `${manifest.name}@${manifest.version}`,
  node: process.version,
  opencode: await describeLaunch(resolved.opencode),
  pi: await describeLaunch(resolved.pi, ["--version", "--offline"], 30_000),
  cursor: await describeLaunch(resolved.cursor),
  claude: await describeLaunch(resolved.claude),
  codex: await describeLaunch(resolved.codex),
  gemini: await describeLaunch(resolved.gemini),
  amp: await describeLaunch(resolved.amp),
};
for (const [name, value] of Object.entries(checks)) process.stdout.write(`${name}: ${value}\n`);

// Generic ACP registrations are trusted executable declarations, so doctor
// reports their non-executable metadata without spawning, initializing,
// signing in to, or probing any registered agent.
{
  const agents = listConfiguredAcpAgents();
  if (!agents.length) {
    process.stdout.write("acp-agent: none configured (metadata only; no executable probe)\n");
  } else {
    for (const agent of agents) {
      const registry = agent.registryId ? ` registry=${agent.registryId}` : "";
      const version = agent.version ? ` version=${agent.version}` : "";
      const protocol = agent.protocolVersion ? ` protocol=${agent.protocolVersion}` : " protocol=negotiate-v2";
      process.stdout.write(`acp-agent: id=${agent.id} trusted=${agent.trusted}${registry}${version}${protocol} (metadata only; not executed)\n`);
    }
  }
}
for (const name of ["acorn", "ajv", "quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "@anthropic-ai/claude-agent-sdk"]) {
  try { import.meta.resolve(name); process.stdout.write(`dynamic-dependency: ${name} available\n`); }
  catch { process.stdout.write(`dynamic-dependency: ${name} MISSING\n`); process.exitCode = 1; }
}

// Routing V2 diagnostics are static: doctor validates configuration without
// executing the trusted resolver or spending a downstream model call.
{
  const routing = readLocalConfig().routing || {};
  const scopes = ["global", "project"].filter((scope) => routing[scope]);
  if (routing.sessions && Object.keys(routing.sessions).length) scopes.push(`sessions:${Object.keys(routing.sessions).length}`);
  const resolver = process.env.HARNEST_ROUTER || routing.resolverModule || null;
  const userPolicyPath = process.env.HARNEST_ROUTING_POLICY
    || routing.userPolicyFile
    || join(homeDir(), ".harnest", "routing.json");
  let userPolicy = "absent";
  try {
    const raw = await readFile(userPolicyPath, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const parsed = raw === null ? null : JSON.parse(raw);
    if (raw !== null && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new TypeError("root must be an object");
    validateRoutingConfiguration(routing, parsed);
    if (raw !== null) {
      userPolicy = "valid";
      scopes.push("user");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      userPolicy = `INVALID (${error.message})`;
      process.exitCode = 1;
    }
  }
  process.stdout.write(`routing: scopes=${scopes.join(",") || "none"} user-policy=${userPolicy} resolver=${resolver ? "configured" : "none"} timeout=${routing.resolverTimeoutMs ?? 5000}ms failure=${routing.resolverFailureMode ?? "closed"}\n`);
  if (userPolicy !== "valid") {
    process.stdout.write("routing-order: (no user policy file)\n");
    process.stdout.write("hint: run node scripts/setup-routing.mjs to set a harness order in one minute\n");
  } else {
    try {
      const parsed = JSON.parse(await readFile(userPolicyPath, "utf8"));
      const order = Array.isArray(parsed?.harnessOrder) ? parsed.harnessOrder : null;
      const tier = typeof parsed?.tier === "string" ? parsed.tier : "(unset)";
      const models = parsed?.models && typeof parsed.models === "object"
        ? Object.entries(parsed.models).map(([target, model]) => `${target}=${model}`).join(", ")
        : "(defaults)";
      const mark = (name) => {
        const line = checks[{ opencode: "opencode", pi: "pi", cursor: "cursor", claude: "claude", codex: "codex", gemini: "gemini", amp: "amp" }[name]];
        if (!line) return "?";
        return /unavailable/i.test(line) ? "✗" : "✓";
      };
      process.stdout.write(`routing-order: ${order ? order.map((name) => `${mark(name)}${name}`).join(" > ") : "(unset — pure score order)"} | tier=${tier} | models: ${models}\n`);
      const pressured = (parsed?.candidates || [])
        .filter((c) => c && c.id && c.health && Number.isFinite(c.health.headroom))
        .map((c) => `${c.id}=${c.health.headroom}${c.health.source ? `(${c.health.source})` : ""}`);
      process.stdout.write(pressured.length
        ? `pressure: ${pressured.join(", ")} (refresh with scripts/set-pressure.mjs; auth probes do not measure quota)\n`
        : "pressure: (none recorded — all lanes neutral; record heat with scripts/set-pressure.mjs)\n");
      const subs = parsed?.subscriptions && typeof parsed.subscriptions === "object" ? parsed.subscriptions : {};
      const subLines = Object.entries(subs).map(([target, entry]) => `${target}=${entry?.subsidy ?? "?"}${entry?.plan ? ` (${entry.plan})` : ""}`);
      process.stdout.write(subLines.length
        ? `subsidy: ${subLines.join(", ")} (0=API billing, 1=fully covered)\n`
        : "subsidy: (none recorded — API economics assumed; run setup-routing to record subs)\n");
      if (!order) {
        process.stdout.write("hint: run node scripts/setup-routing.mjs to set a harness order in one minute\n");
      }
    } catch {
      process.stdout.write("routing-order: (unreadable policy file)\n");
    }
  }
}

// Marketplace isolation: the retired `personal` marketplace must stay gone and no
// @personal plugin entries may reappear in `codex plugin list`.
// Fails closed: if codex output cannot be obtained at all the gate reports
// UNKNOWN with a non-zero exit instead of silently passing.
{
  let stdout = null;
  if (resolved.codex.ok) {
    const { command, args } = resolved.codex.launch;
    try {
      ({ stdout } = await runProcess(command, [...(args || []), "plugin", "list"], { timeoutMs: 30_000 }));
    } catch { /* Report the unavailable plugin list below. */ }
  }
  if (stdout == null) {
    const nonWindows = process.platform !== "win32";
    process.stdout.write(nonWindows
      ? "marketplace-isolation: skipped (non-Windows host, codex unavailable)\n"
      : "marketplace-isolation: UNKNOWN — codex output unavailable; investigate manually\n");
    if (!nonWindows) process.exitCode = 1;
  } else {
    const hits = stdout.split(/\r?\n/).filter((l) => /@personal|Marketplace `personal`/i.test(l));
    if (hits.length === 0) {
      process.stdout.write("marketplace-isolation: ok (no personal marketplace or @personal entries)\n");
    } else {
      process.stdout.write(`marketplace-isolation: FAIL — remove via 'codex plugin marketplace remove personal'\n${hits.join("\n")}\n`);
      process.exitCode = 1;
    }
  }
}

// Pinned-model freshness: warn when pins predate a 24h-old snapshot or name
// models absent from the live list. Stale snapshots never bless old pins.
{
  const { readFile: readSnapshotFile } = await import("node:fs/promises");
  const { comparePins, defaultSnapshotPath, isSnapshotFresh } = await import("../src/model-freshness.mjs");
  // NOTE: userPolicyPath from the routing block above is block-scoped; resolve again here.
  const freshnessPolicyPath = process.env.HARNEST_ROUTING_POLICY
    || (readLocalConfig().routing || {}).userPolicyFile
    || join(homeDir(), ".harnest", "routing.json");
  try {
    const raw = await readSnapshotFile(defaultSnapshotPath(), "utf8").catch(() => null);
    const snapshot = raw ? JSON.parse(raw) : null;
    let pins = {};
    try {
      const parsed = JSON.parse(await readFile(freshnessPolicyPath, "utf8"));
      if (parsed?.models && typeof parsed.models === "object") pins = parsed.models;
    } catch (error) {
      // Read/parse failures mean "no usable pins". Anything else (e.g. a
      // scoping bug) must surface, not silently empty the pin set.
      if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") throw error;
      pins = {};
    }
    if (!snapshot) {
      process.stdout.write("models: no snapshot yet — run node scripts/refresh-models.mjs for a live Cursor list\n");
    } else if (!isSnapshotFresh(snapshot)) {
      process.stdout.write("models: snapshot older than 24h — re-run node scripts/refresh-models.mjs before trusting pins\n");
      process.exitCode = 1;
    } else {
      const warnings = comparePins(pins, snapshot);
      if (!Object.keys(pins).length) process.stdout.write("models: no pins (harness defaults track latest)\n");
      else if (!warnings.length) process.stdout.write("models: pins ok against live snapshot\n");
      else {
        for (const warning of warnings) process.stdout.write(`models: WARN [${warning.target}] ${warning.model}: ${warning.reason}\n`);
        process.exitCode = 1;
      }
      const cheap = snapshot.harnesses?.cursor?.cheap;
      if (Array.isArray(cheap) && cheap.length) {
        process.stdout.write(`models: cheap cursor lanes: ${cheap.slice(0, 3).map((line) => String(line).split(" - ")[0]).join(", ")}\n`);
      }
    }
  } catch (error) {
    process.stdout.write(`models: UNKNOWN — ${error.message}\n`);
    process.exitCode = 1;
  }
}

// Generated Codex workers are read-only bridges with high effort.
{
  const { readdir } = await import("node:fs/promises");
  try {
    const files = (await readdir(join(root, "codex-agents"))).filter((f) => f.endsWith("_worker.toml"));
    let bad = 0;
    for (const file of files) {
      const raw = await readFile(join(root, "codex-agents", file), "utf8");
      const need = ["name", "description", "developer_instructions", "model_reasoning_effort", "sandbox_mode"];
      const missing = need.filter((key) => !new RegExp(`^${key}\\s*=`, "m").test(raw));
      const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(raw)?.[1];
      if (effort !== "high" && !missing.includes("model_reasoning_effort")) missing.push("model_reasoning_effort");
      if (missing.length) {
        process.stdout.write(`codex-worker: FAIL — ${file} missing/invalid: ${missing.join(",")}\n`);
        bad += 1;
      }
    }
    if (bad === 0) process.stdout.write(`codex-workers: ok (${files.length} workers, high effort)\n`);
    else process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`codex-workers: UNKNOWN — ${error.message}\n`);
    process.exitCode = 1;
  }
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME;
}
