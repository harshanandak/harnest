import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { harnessLaunch, isOpenCodeV2Version } from "../src/config.mjs";
import { resolveTaskflowExtensionPath } from "../src/adapters/pi.mjs";
import { requireNativeCommand, spawnNativeCommand } from "../src/launch-command.mjs";
import { terminateProcessTree } from "../src/process.mjs";

export function versionOf(target, { resolveLaunch = harnessLaunch, spawnSyncFn } = {}) {
  const launch = resolveLaunch(target);
  const versionArgs = [...(launch.args || []), "--version", ...(target === "pi" ? ["--offline"] : [])];
  const command = spawnSyncFn ? launch.command : requireNativeCommand(launch.command);
  const result = (spawnSyncFn || spawnSync)(command, versionArgs, {
    encoding: "utf8",
    timeout: target === "pi" ? 30_000 : 10_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error
      ? `${result.error.code || result.error.name}: ${result.error.message}`
      : `exit=${result.status} signal=${result.signal || "none"}: ${String(result.stderr || result.stdout || "no output").slice(-500)}`;
    throw Object.assign(new Error(`${target} --version failed: ${reason}`), { code: result.error?.code });
  }
  const version = String(result.stdout || result.stderr).trim().split(/\r?\n/).at(-1);
  if (target === "opencode" && !isOpenCodeV2Version(version)) throw new Error("OpenCode V2 is required");
  return version;
}

// Optional compatibility capability: verifies the installed pi-taskflow
// extension registers its deterministic /tf command. Ordinary Pi readiness
// (smokePiCore) must not depend on this package being installed.
export async function smokePiTaskflow(options = {}) {
  return smokePiProbe({ ...options, withTaskflow: true });
}

export async function smokePiCore(options = {}) {
  return smokePiProbe({ ...options, withTaskflow: false });
}

async function smokePiProbe(options = {}) {
  const cwd = options.cwd || await mkdtemp(join(tmpdir(), "harnest-pi-readiness-"));
  try {
    return await probePiRpc({ ...options, cwd });
  } finally {
    if (!options.cwd) await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function probePiRpc({ resolveLaunch = harnessLaunch, spawnFn = spawnNativeCommand, timeoutMs = 120_000, cleanupTimeoutMs = 5_000, cwd, withTaskflow = false }) {
  const launch = resolveLaunch("pi");
  const taskflowExtensionPath = withTaskflow ? resolveTaskflowExtensionPath(undefined) : null;
  const args = [
    ...(launch.args || []),
    "--mode", "rpc",
    ...(withTaskflow ? ["--extension", taskflowExtensionPath, "--tools", "taskflow,read"] : ["--tools", "read"]),
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ];
  return new Promise((resolve, reject) => {
    const child = spawnFn(launch.command, args, {
      cwd,
      env: { ...process.env, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let stopping = false;
    let closed = false;
    let outcome;
    let cleanupTimer;
    let forceTimer;
    const settle = () => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      clearTimeout(forceTimer);
      if (outcome) reject(outcome);
      else resolve();
    };
    const finish = (error) => {
      if (stopping) return;
      stopping = true;
      outcome = error;
      clearTimeout(timer);
      if (closed) return settle();
      child.stdin.end();
      terminateProcessTree(child);
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      }, Math.min(1_000, cleanupTimeoutMs / 2));
      cleanupTimer = setTimeout(() => {
        outcome = new Error(`Pi RPC cleanup timed out${outcome ? `: ${outcome.message}` : ""}`);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle();
      }, cleanupTimeoutMs);
    };
    child.stdout.on("data", (chunk) => {
      if (stopping) return;
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch {
          // Pi can emit non-RPC startup lines; only the matching response matters.
          continue;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        if (message.id !== "harnest-smoke") continue;
        const commands = message.data?.commands || message.commands || [];
        const names = Array.isArray(commands) ? commands.map((command) => typeof command === "string" ? command : command?.name) : [];
        const healthy = message.success !== false && (!withTaskflow || names.includes("tf"));
        finish(healthy ? null : new Error(withTaskflow ? "Pi loaded without the /tf command" : "Pi RPC did not acknowledge get_commands"));
        return;
      }
      if (stdout.length > 64 * 1024) finish(new Error("Pi RPC smoke received an oversized unterminated response"));
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      closed = true;
      if (!stopping) finish(new Error(`Pi RPC exited ${code}: ${stderr.slice(-500)}`));
      else settle();
    });
    const timer = setTimeout(() => finish(new Error(`Pi RPC smoke timed out: ${stderr.slice(-500)}`)), timeoutMs);
    child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "harnest-smoke" })}\n`, (error) => {
      if (error) finish(error);
    });
  });
}

export async function smokeHarnesses({ versionProbe = versionOf, piProbe = smokePiCore, piTaskflowProbe = smokePiTaskflow, report = console.log } = {}) {
  const results = [];
  for (const target of ["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp"]) {
    const required = !["gemini", "amp"].includes(target);
    const name = target;
    try {
      const version = await versionProbe(target);
      let taskflow = null;
      if (target === "pi") {
        await piProbe();
        try {
          await piTaskflowProbe();
          taskflow = "tf";
        } catch (error) {
          taskflow = "optional-unavailable";
          report(`HARNESS_SMOKE target=pi-taskflow required=false status=optional-unavailable reason=${error.code ? `${error.code}: ` : ""}${String(error.message).replace(/\s+/g, " ")}`);
        }
      }
      results.push({ target, name, required, ok: true, version, taskflow });
      report(`HARNESS_SMOKE target=${name} required=${required} status=ready version=${version}${target === "pi" ? ` piCore=ready piTaskflow=${taskflow}` : ""}`);
    } catch (error) {
      results.push({ target, name, required, ok: false, error });
      report(`HARNESS_SMOKE target=${name} required=${required} status=${required ? "failed" : "optional-unavailable"} reason=${error.code ? `${error.code}: ` : ""}${String(error.message).replace(/\s+/g, " ")}`);
    }
  }
  const ok = results.every((result) => !result.required || result.ok);
  report(ok ? "HARNESS_SMOKE_OK" : "HARNESS_SMOKE_FAILED");
  return { ok, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok } = await smokeHarnesses();
  if (!ok) process.exitCode = 1;
}
