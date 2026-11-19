import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the Pi extension registers the full handoff surface and a host-info tool", async () => {
  const raw = await readFile(join(root, "pi-extension", "harnest.mjs"), "utf8");
  assert.match(raw, /export default function harnestExtension/);
  for (const tool of [
    "handoff_workflow",
    "handoff_compare",
    "handoff_review",
    "handoff_post",
    "handoff_read",
    "handoff_fleet",
    "handoff_graph_validate",
    "handoff_graph_start",
    "handoff_graph_status",
    "handoff_graph_result",
    "handoff_graph_cancel",
    "handoff_graph_resume",
    "handoff_status",
    "handoff_result",
    "handoff_trace",
    "handoff_sessions",
    "handoff_message",
    "handoff_reroute",
    "handoff_cancel",
    "handoff_resume",
    "handoff_host_info",
  ]) {
    assert.ok(raw.includes(`name: "${tool}"`), `extension must register ${tool}`);
  }
  for (const command of ["harnest_info", "harnest_status", "harnest_trace", "harnest_result", "harnest_sessions", "harnest_cancel"]) {
    assert.ok(raw.includes(`"${command}"`), `extension must register /${command}`);
  }
  for (const feature of ["promptSnippet", "promptGuidelines", "prepareArguments", "signal?.aborted", "onUpdate", "appendEntry"]) {
    assert.ok(raw.includes(feature), `extension must use ${feature}`);
  }
});

test("the extension imports the HTTP client and only presentation helpers", async () => {
  const raw = await readFile(join(root, "pi-extension", "harnest.mjs"), "utf8");
  assert.match(raw, /import \{ createDaemonClient, ensureDaemon \} from "__HARNEST_DAEMON_CLIENT_URL__";/);
  assert.doesNotMatch(raw, /Companion|GraphRunner|dynamic-tools|dynamic-runner|routing-tools/);
});

test("the Pi installer bakes the repo path and registers settings plus skill", async () => {
  const raw = await readFile(join(root, "scripts", "install-pi-integration.mjs"), "utf8");
  for (const artifact of ["__HARNEST_DAEMON_CLIENT_URL__", "pathToFileURL", "settings.json", "extensions", "skills", "handoff"]) {
    assert.ok(raw.includes(artifact), `installer must reference ${artifact}`);
  }
});

test("the Pi installer is import-safe, replaces stale extension entries, and backs up replaced files", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "harnest-pi-install-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    // A cache-busted import re-executes the module: under the guard it must leave the fake home untouched.
    const installer = await import(`${new URL("../scripts/install-pi-integration.mjs", import.meta.url).href}?guard=${Date.now()}`);
    assert.equal(existsSync(join(fakeHome, ".pi")), false, "importing the installer must write nothing");
    assert.deepEqual(
      installer.mergeExtensionList([
        "/old/checkout/extensions/harnest.mjs",
        "/keep/other-extension.mjs",
        "/old/extensions/Harnest.MJS",
      ], "/new/checkout/extensions/harnest.mjs"),
      ["/keep/other-extension.mjs", "/new/checkout/extensions/harnest.mjs"],
      "stale registrations of this extension must be replaced, not appended",
    );
    const raw = await readFile(join(root, "scripts", "install-pi-integration.mjs"), "utf8");
    assert.ok(raw.includes(".bak-harnest-"), "replaced extension and skill files must be backed up");
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("the installed Pi artifacts exist on this machine", () => {
  const piDir = join(homedir(), ".pi", "agent");
  const baked = join(piDir, "extensions", "harnest.mjs");
  if (!existsSync(baked)) return; // not installed on this machine; installer test above still applies
  const raw = readFileSync(baked, "utf8");
  assert.doesNotMatch(raw, /__HARNEST_DAEMON_CLIENT_URL__/);
  assert.doesNotMatch(raw, /__HARNEST_GRAPH_VIEW_URL__/);
  assert.match(raw, /file:\/\/\/.+src\/daemon-client\.mjs"/);
});

// ---------------------------------------------------------------------------
// Live workflow view (/harnest_view, /harnest_watch, handoff_view)
// ---------------------------------------------------------------------------

const extensionSource = async () => {
  const raw = await readFile(join(root, "pi-extension", "harnest.mjs"), "utf8");
  return raw
    .replace("__HARNEST_DAEMON_CLIENT_URL__", `data:text/javascript;base64,${Buffer.from(`
      export const ensureDaemon = async () => ({ ready: true });
      export const createDaemonClient = () => ({
        listTools: async () => [],
        call: async () => ({ host: { routingResolverConfigured: false, routingResolver: null } }),
      });
    `).toString("base64")}`)
    .replace("__HARNEST_DAEMON_SETTINGS_URL__", new URL("../src/daemon-settings.mjs", import.meta.url).href)
    .replace("__HARNEST_DYNAMIC_VIEW_URL__", new URL("../src/dynamic-view.mjs", import.meta.url).href)
    .replace("__HARNEST_LAUNCH_COMMAND_URL__", new URL("../src/launch-command.mjs", import.meta.url).href)
    .replace("__HARNEST_GRAPH_VIEW_URL__", new URL("../scripts/graph-view.mjs", import.meta.url).href)
    .replace('"@earendil-works/pi-ai"', JSON.stringify(import.meta.resolve("@earendil-works/pi-ai")))
    .replace('"typebox"', JSON.stringify(import.meta.resolve("typebox")));
};

const loadPiExtension = async () => import(`data:text/javascript;base64,${Buffer.from(await extensionSource()).toString("base64")}`);

const stubPi = (overrides = {}) => {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (event, handler) => handlers.set(event, handler),
    appendEntry: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    ...overrides,
  };
  return { pi, tools, commands, handlers };
};

test("Pi publishes strict route, execution, and policy contracts for single and graph handoffs", async () => {
  const { default: extension } = await loadPiExtension();
  const { pi, tools } = stubPi();
  extension(pi);
  const request = tools.get("handoff_workflow").parameters.properties.request;
  assert.deepEqual(Object.keys(request.properties.route.properties), ["provider", "model", "agent", "variant", "thinking", "harnessVersion", "serverUrl", "serviceTier", "profile", "options"]);
  assert.equal(request.properties.route.additionalProperties, false);
  assert.deepEqual(Object.keys(request.properties.execution.properties), ["background", "timeoutMs", "sessionId", "addDirs", "attachments", "instructions", "sessionAction", "maxTurns", "transport"]);
  assert.equal(request.properties.execution.additionalProperties, false);
  assert.deepEqual(request.properties.route.properties.harnessVersion, { type: "string", enum: ["v2"], description: "OpenCode only: v2 or omitted." });
  assert.deepEqual(tools.get("handoff_reroute").parameters.properties.route.properties.harnessVersion, { type: "string", enum: ["v2"] });
  const policy = request.properties.policy;
  assert.deepEqual(Object.keys(policy.properties), ["write", "readOnly", "allowWrites", "tools", "mode", "sandbox", "maxCostUsd"]);
  const [legacyTools, explicitTools] = policy.properties.tools.anyOf;
  assert.equal(legacyTools.type, "array");
  assert.deepEqual(Object.keys(explicitTools.properties), ["allow", "deny"]);
  assert.equal(explicitTools.additionalProperties, false);
  assert.equal(policy.properties.mode.const, "plan");
  assert.equal(policy.properties.sandbox.type, "boolean");
  assert.equal(request.properties.policy.additionalProperties, false);
  const graph = tools.get("handoff_graph_start").parameters.properties.graph;
  assert.equal(graph.properties.policy.additionalProperties, false);
  const node = graph.properties.nodes.items;
  assert.deepEqual(Object.keys(node.properties.route.properties), ["provider", "model", "agent", "variant", "thinking", "harnessVersion", "serverUrl", "serviceTier", "profile", "options"]);
  assert.equal(node.properties.route.additionalProperties, false);
  assert.deepEqual(Object.keys(node.properties.execution.properties), ["timeoutMs", "sessionId", "addDirs", "attachments", "instructions", "sessionAction", "maxTurns"]);
  assert.equal(node.properties.execution.additionalProperties, false);
  assert.equal(node.properties.policy.additionalProperties, false);
  const readOnlyTargets = ["opencode", "pi", "cursor", "claude", "codex", "gemini"];
  assert.deepEqual(tools.get("handoff_compare").parameters.properties.request.properties.target.enum, readOnlyTargets);
  assert.deepEqual(tools.get("handoff_compare").parameters.properties.candidates.items.properties.target.enum, readOnlyTargets);
  assert.deepEqual(tools.get("handoff_review").parameters.properties.request.properties.target.enum, readOnlyTargets);
  assert.deepEqual(tools.get("handoff_review").parameters.properties.reviewers.items.properties.target.enum, readOnlyTargets);
  const hostResult = await tools.get("handoff_host_info").execute("host-info", {}, new AbortController().signal);
  const host = JSON.parse(hostResult.content[0].text);
  assert.equal(host.writeApproval.marker, "metadata.harnest.writeApproved=true");
  assert.match(host.nestedHandoffs, /cannot widen/);
});

const FRAME = [
  "Plan probe  running  2/3 nodes  12s",
  "plan-probe-request  graph-0123456789abcdef...",
  "",
  "workflows  2   ●1 active",
  "▸ Plan probe                                   2/3  running",
  "  Older run                                    1/1  completed",
  "",
  "  Plan probe                          2/3  running",
  "    ├─ + Draft                      deepseek-v4 · high",
  "  + Review                           deepseek-v4 · medium",
  "  ○ Join                              pending",
  "",
  "enter open node   up/down select   r refresh   q quit",
  "",
].join("\n");

test("the Pi extension wires the live workflow view into commands, a tool, and the installer", async () => {
  const raw = await readFile(join(root, "pi-extension", "harnest.mjs"), "utf8");
  for (const surface of ['command("harnest_view"', 'command("harnest_watch"', 'name: "handoff_view"', "__HARNEST_GRAPH_VIEW_URL__", "setWidget(VIEW_WIDGET_KEY", "setWidget(VIEW_WIDGET_KEY, undefined)", "session_shutdown", "clearInterval(viewTimer)"]) {
    assert.ok(raw.includes(surface), `extension must wire the live view through ${surface}`);
  }
  const installer = await readFile(join(root, "scripts", "install-pi-integration.mjs"), "utf8");
  assert.ok(installer.includes("__HARNEST_GRAPH_VIEW_URL__"), "installer must bake the graph-view path");
  assert.ok(installer.includes('join(root, "scripts", "graph-view.mjs")'), "installer must bake scripts/graph-view.mjs");
  assert.ok(installer.includes("__HARNEST_[A-Z_]+__"), "installer must reject unbaked placeholders");
});

test("Pi /harnest_view renders the shared waterfall into a widget and stops cleanly", { timeout: 30_000 }, async () => {
  const { default: extension, terminalLaunchPlan, terminalLauncher } = await loadPiExtension();
  const { pi, tools, commands, handlers } = stubPi();
  const execCalls = [];
  pi.exec = async (command, args, options) => {
    execCalls.push({ command, args, options });
    return { stdout: FRAME, stderr: "", code: 0, killed: false };
  };
  extension(pi);
  const widgets = [];
  const statuses = [];
  const notes = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
      setStatus: (key, text) => statuses.push({ key, text }),
      notify: (message, type) => notes.push({ message, type }),
    },
  };
  handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.ok(tools.has("handoff_view"), "handoff_view must be registered");
  assert.ok(commands.has("harnest_view") && commands.has("harnest_watch"), "both live-view commands must be registered");

  await commands.get("harnest_view").handler("", ctx);
  assert.equal(execCalls[0].command, process.execPath);
  assert.ok(execCalls[0].args[0].endsWith("graph-view.mjs"), "the widget must render through the shared graph-view");
  assert.ok(execCalls[0].args.includes("--plain"), "the widget frame must be ANSI-free and static");
  assert.equal(execCalls[0].options.cwd, root, "graph-view must run at the repo root so the store and scripts resolve");
  const first = widgets.at(-1);
  assert.equal(first.key, "harnest-view");
  const rendered = first.lines.join("\n");
  assert.match(rendered, /Plan probe/);
  assert.match(rendered, /deepseek-v4 · high/, "per-node model and thinking level must reach the widget");
  assert.match(rendered, /workflows  2/, "the workflow switcher must render above the waterfall");
  assert.match(rendered, /├─ \+ Draft {2}deepseek-v4/, "tree indentation must survive padding collapse");
  assert.doesNotMatch(rendered, /enter open node/, "the terminal-only key hint must not leak into the widget");
  assert.ok(first.lines.every((line) => [...line].length <= 120));
  assert.deepEqual(statuses.at(-1), { key: "harnest-view", text: "Harnest view: 2/3 running" });

  const view = await tools.get("handoff_view").execute("view-call", {}, new AbortController().signal);
  assert.match(view.content[0].text, /Plan probe/);
  assert.doesNotMatch(view.content[0].text, /enter open node/);

  const before = execCalls.length;
  await commands.get("harnest_view").handler("interval 250", ctx);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(execCalls.length > before + 1, `the live view must keep refreshing (saw ${execCalls.length - before} refreshes)`);

  await commands.get("harnest_view").handler("off", ctx);
  assert.equal(widgets.at(-1).lines, undefined, "/harnest_view off must clear the widget");
  assert.equal(statuses.at(-1).text, undefined, "/harnest_view off must clear the status");
  const afterOff = execCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(execCalls.length, afterOff, "no renderer may run once the view is off");

  const launches = [];
  terminalLauncher.spawn = (command, args, options) => {
    launches.push({ command, args, options });
    return { unref() {} };
  };
  await commands.get("harnest_watch").handler("", ctx);
  const planned = terminalLaunchPlan({ commandLine: "node x" });
  if (planned) {
    assert.equal(launches.length, 1, "a side terminal must be spawned when a launcher exists");
    assert.match(notes.at(-1).message, /opened in/);
  } else {
    assert.equal(launches.length, 0);
    assert.match(notes.at(-1).message, /open a terminal in/);
  }

  // A launcher that fails must degrade to the copy-paste command, never silence.
  terminalLauncher.spawn = async () => { throw new Error("no launcher"); };
  await commands.get("harnest_watch").handler("", ctx);
  assert.equal(notes.at(-1).type, "warning");
  assert.match(notes.at(-1).message, /graph-view\.mjs"? --watch/);
  assert.doesNotMatch(notes.at(-1).message, /--plain/, "the side viewer must be interactive, not a single inert frame");

  // An unsafe selector must be refused with a warning, never interpolated into a shell line.
  let spawnAttempts = 0;
  terminalLauncher.spawn = () => { spawnAttempts += 1; throw new Error("no launcher"); };
  await commands.get("harnest_watch").handler("graph-$evil", ctx);
  assert.equal(spawnAttempts, 0, "an unsafe selector must not reach the launcher");
  assert.equal(notes.at(-1).type, "warning");
  assert.match(notes.at(-1).message, /cannot open the workflow viewer/);
  assert.doesNotMatch(notes.at(-1).message, /\$evil/);

  await commands.get("harnest_view").handler("", ctx);
  handlers.get("session_shutdown")({ reason: "quit" }, ctx);
  const afterShutdown = execCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(execCalls.length, afterShutdown, "session_shutdown must stop the refresh timer");
  assert.equal(widgets.at(-1).lines, undefined, "session_shutdown must clear the widget");
});

test("Pi side terminals resolve both the emulator and nested shell through absolute PATH", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-terminal-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const installed = join(cwd, "installed bin");
  await mkdir(installed);
  for (const command of ["xterm", "sh", "osascript"]) {
    for (const directory of [cwd, installed]) {
      await writeFile(join(directory, command), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
  }
  const { terminalLaunchPlan } = await loadPiExtension();
  const commandLine = "/usr/bin/node /repo/graph-view.mjs --watch";
  const env = { PATH: relative(process.cwd(), cwd) + ":" + installed };
  const plan = terminalLaunchPlan({ commandLine, platform: "linux", env });
  assert.deepEqual(plan, {
    via: "xterm", command: join(installed, "xterm"), args: ["-e", join(installed, "sh"), "-lc", commandLine],
  });
  assert.equal(terminalLaunchPlan({ commandLine, platform: "darwin", env }).command, join(installed, "osascript"));
});

test("Pi workflow-view helpers fit frames to the widget and plan a side terminal", async () => {
  const { widgetRows, graphViewArgs, frameSummary, terminalLaunchPlan, graphViewCommandLine, terminalLauncher } = await loadPiExtension();
  const rows = widgetRows(["title  running  2/3 nodes  9s", "a".repeat(50), "b", "c", "enter open node   up/down select   r refresh   q quit", ""].join("\n"), { width: 40, maxRows: 3 });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => [...row].length <= 40));
  assert.doesNotMatch(rows.join("\n"), /enter open node/);
  assert.match(rows.at(-1), /2 more rows/);
  assert.equal([...widgetRows("a".repeat(50), { width: 12 })[0]].length, 12, "rows must clip to the widget width");
  assert.deepEqual(widgetRows("  ├─ + Draft          deepseek-v4 · high", { width: 120 }), ["  ├─ + Draft  deepseek-v4 · high"]);
  assert.deepEqual(graphViewArgs({ graphId: "graph-abc", ascii: true }), ["--plain", "--ascii", "graph-abc"]);
  assert.deepEqual(graphViewArgs({ list: true }), ["--plain", "--list"]);
  assert.deepEqual(graphViewArgs({ graphId: "graph-abc", ascii: true, watch: true }), ["--watch", "--ascii", "graph-abc"]);
  assert.deepEqual(frameSummary("Plan probe  running  2/3 nodes  12s"), { title: "Plan probe", state: "running", completed: 2, total: 3 });
  assert.equal(frameSummary("not a frame"), null);
  assert.equal(terminalLaunchPlan({ commandLine: "node x", platform: "linux", env: { PATH: "." } }), null);
  assert.equal(terminalLaunchPlan({ commandLine: "node x", platform: "darwin", env: { PATH: "." } }), null);
  const windowsPlan = terminalLaunchPlan({ commandLine: "node x", platform: "win32", env: { SystemRoot: "C:\\Windows" } });
  assert.equal(windowsPlan.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(windowsPlan.args, ["/d", "/c", "start", "", "C:\\Windows\\System32\\cmd.exe", "/d", "/k", "node x"]);
  assert.equal(terminalLaunchPlan({ commandLine: "node x", platform: "win32", env: {} }), null);
  assert.equal(graphViewCommandLine("C:\\Program Files\\node.exe", "C:\\repo\\graph-view.mjs", ["--plain"]), '"C:\\Program Files\\node.exe" C:\\repo\\graph-view.mjs --plain');
  assert.equal(graphViewCommandLine("C:\\Program Files\\node.exe", "C:\\repo\\graph-view.mjs", ["--watch", "graph-abc"]), '"C:\\Program Files\\node.exe" C:\\repo\\graph-view.mjs --watch graph-abc');
  // A checkout at C:\R&D\... breaks cmd's parse; a `$` argument expands in POSIX sh.
  assert.equal(graphViewCommandLine("node", "C:\\R&D\\repo\\scripts\\graph-view.mjs", ["--watch"]), null, "a cmd metacharacter in the checkout path must not reach a command line");
  assert.equal(graphViewCommandLine("node", "C:\\repo\\scripts\\graph-view.mjs", ["--watch", "$(pwned)"]), null, "a shell metacharacter in an argument must not reach a command line");
  assert.equal(typeof terminalLauncher.spawn, "function");
});
