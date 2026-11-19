import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { readdir, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { boundedProviderText, mergeProcessEnv, runProcess } from "../process.mjs";
import { normalizePolicyControls } from "../protocol.mjs";

export const GEMINI_CLI_VERSION = "0.62.0";

const READ_TOOLS = [
  "glob",
  "grep_search",
  "list_directory",
  "read_file",
  "read_many_files",
  "get_internal_docs",
  "google_web_search",
  "web_fetch",
];

const WRITE_TOOLS = ["write_file", "replace", "run_shell_command"];
const NATIVE_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);

function policyError(message, kind = "policy", details = {}) {
  const error = new Error(message);
  error.name = "GeminiAdapterError";
  error.details = { kind, ...details };
  return error;
}

export function geminiSystemPoliciesDir(platform = process.platform) {
  if (platform === "darwin") return "/Library/Application Support/GeminiCli/policies";
  if (platform === "win32") return "C:\\ProgramData\\gemini-cli\\policies";
  return "/etc/gemini-cli/policies";
}

async function assertNoSystemToml(systemPoliciesDir, fsApi) {
  let entries;
  try {
    entries = await fsApi.readdir(systemPoliciesDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw policyError("Gemini system policy directory could not be inspected; refusing to launch because v0.62.0 may ignore the isolated admin policy", "policy", {
      reason: "system-policy-preflight-failed",
      code: error?.code || null,
    });
  }
  const toml = entries.filter((entry) => typeof entry === "string" && entry.endsWith(".toml"));
  if (toml.length) {
    throw policyError("Gemini system policies are present; v0.62.0 ignores invocation --admin-policy in this state, so Harnest cannot enforce the requested boundary", "policy", {
      reason: "system-policy-conflict",
      count: toml.length,
    });
  }
}

export function geminiTools(policy = {}) {
  const { tools } = normalizePolicyControls(policy);
  if (Array.isArray(tools) && tools.length) {
    throw policyError("Gemini policy.tools requires explicit allow or deny with native Gemini tool names", "policy", {
      reason: "unsupported-tools",
    });
  }
  const { allow, deny } = tools;
  if ([...(allow ?? []), ...(deny ?? [])].some((name) => !NATIVE_TOOLS.has(name))) {
    throw policyError("Gemini policy.tools contains a name outside Harnest's verified native tool set");
  }
  return [...READ_TOOLS, ...(policy.write === true ? WRITE_TOOLS : [])]
    .filter((name) => (allow === undefined || allow.includes(name)) && !deny?.includes(name));
}

function settingsJson(core) {
  return `${JSON.stringify({
    security: {
      disableYoloMode: true,
      disableAlwaysAllow: true,
      enablePermanentToolApproval: false,
    },
    hooksConfig: { enabled: false },
    hooks: {},
    admin: {
      secureModeEnabled: true,
      extensions: { enabled: false },
      mcp: { enabled: false, config: {}, requiredConfig: {} },
      skills: { enabled: false },
    },
    tools: { core, discoveryCommand: "", callCommand: "" },
    mcp: { serverCommand: "" },
    context: { loadMemoryFromIncludeDirectories: false },
  }, null, 2)}\n`;
}

function policyToml(allowed) {
  const deny = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\ndenyMessage = "Tool denied by the Harnest invocation policy."\n';
  if (!allowed.length) return deny;
  const quoted = allowed.map((tool) => `  ${JSON.stringify(tool)},`).join("\n");
  return `# Generated per invocation by Harnest.\n\n[[rule]]\ntoolName = [\n${quoted}\n]\ndecision = "allow"\npriority = 999\ninteractive = false\n\n${deny}`;
}

export async function probeGeminiVersion({ command, launchArgs = [], cwd, env, spawnFn, signal, unsetEnv = [], timeoutMs = 10_000 } = {}) {
  let result;
  try {
    const baseSpawn = spawnFn || spawnNativeCommand;
    const unset = unsetEnv.map((name) => String(name).toLowerCase());
    const isolatedSpawn = (childCommand, childArgs, options) => {
      for (const key of Object.keys(options.env || {})) {
        if (unset.includes(key.toLowerCase())) delete options.env[key];
      }
      return baseSpawn(childCommand, childArgs, options);
    };
    result = await runProcess(command, [...launchArgs, "--version"], {
      cwd,
      env: mergeProcessEnv(env),
      spawnFn: isolatedSpawn,
      signal,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof NativeLaunchError) throw error;
    const details = error?.details || {};
    const kind = ["abort", "timeout"].includes(details.kind) ? details.kind : "transport";
    throw policyError(`Gemini CLI version preflight failed: ${boundedProviderText(error?.message || String(error))}`, kind, {
      kind,
      phase: "version-preflight",
      code: details.code ?? null,
      exitCode: details.exitCode ?? null,
      signal: details.signal ?? null,
      stderr: typeof details.stderr === "string" ? boundedProviderText(details.stderr, 4000) : "",
      stderrBytes: details.stderrBytes ?? null,
      stderrTruncated: Boolean(details.stderrTruncated),
      timedOut: Boolean(details.timedOut),
      aborted: Boolean(details.aborted),
      hint: "install Gemini CLI 0.62.0 and ensure the configured executable is available",
    });
  }
  const version = String(result.stdout || "").trim().replace(/^v/i, "");
  if (version !== GEMINI_CLI_VERSION) {
    throw policyError(`Gemini CLI ${version || "unknown"} is unsupported; this adapter requires exactly ${GEMINI_CLI_VERSION} because its native policy precedence is version-specific`, "unavailable", {
      reason: "unsupported-version",
      requiredVersion: GEMINI_CLI_VERSION,
      observedVersion: boundedProviderText(version, 100) || null,
    });
  }
  return version;
}

export function createGeminiPolicyPreparer(options = {}) {
  const fsApi = options.fsApi || { readdir, mkdir, mkdtemp, rm, writeFile };
  const systemPoliciesDir = options.systemPoliciesDir || geminiSystemPoliciesDir(options.platform);
  const versionProbe = options.versionProbe || probeGeminiVersion;
  return {
    async prepare({ request, policy, cwd, launch, spawnFn, env, signal, timeoutMs }) {
      const allowedTools = geminiTools(policy);
      const launchArgs = Array.isArray(launch?.args) ? launch.args : [];
      if (signal?.aborted) throw policyError("Gemini execution aborted before native policy preparation", "abort", { aborted: true });
      await assertNoSystemToml(systemPoliciesDir, fsApi);

      const root = await fsApi.mkdtemp(join(tmpdir(), "harnest-gemini-"));
      const adminPolicyDir = join(root, "admin-policy");
      const userPolicyDir = join(root, "user-policy");
      const systemSettingsPath = join(root, "system-settings.json");
      const systemDefaultsPath = join(root, "system-defaults.json");
      const adminPolicyPath = join(adminPolicyDir, "harnest.toml");
      let ready = false;
      try {
        await Promise.all([
          fsApi.mkdir(adminPolicyDir, { recursive: true, mode: 0o700 }),
          fsApi.mkdir(userPolicyDir, { recursive: true, mode: 0o700 }),
          fsApi.mkdir(dirname(systemSettingsPath), { recursive: true, mode: 0o700 }),
        ]);
        await Promise.all([
          fsApi.writeFile(systemSettingsPath, settingsJson(allowedTools), { encoding: "utf8", mode: 0o600 }),
          fsApi.writeFile(systemDefaultsPath, "{}\n", { encoding: "utf8", mode: 0o600 }),
          fsApi.writeFile(adminPolicyPath, policyToml(allowedTools), { encoding: "utf8", mode: 0o600 }),
        ]);
        const isolatedEnv = mergeProcessEnv({
          ...(launch?.env || {}),
          ...(env || {}),
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: systemDefaultsPath,
        });
        for (const key of Object.keys(isolatedEnv)) {
          if (key.toLowerCase() === "gemini_cli_ide_workspace_path") delete isolatedEnv[key];
        }
        await versionProbe({
          command: launch?.command,
          launchArgs,
          cwd,
          env: isolatedEnv,
          spawnFn,
          signal,
          unsetEnv: ["GEMINI_CLI_IDE_WORKSPACE_PATH"],
          timeoutMs: Math.max(1, Math.min(timeoutMs ?? request?.execution?.timeoutMs ?? 10_000, 10_000)),
        });
        if (signal?.aborted) throw policyError("Gemini execution aborted during version preflight", "abort", { aborted: true });
        // Re-check after materializing the invocation policy. Gemini v0.62.0
        // silently ignores --admin-policy when this directory contains TOML.
        await assertNoSystemToml(systemPoliciesDir, fsApi);
        ready = true;
      } finally {
        if (!ready) await fsApi.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).catch(() => {});
      }

      let cleaned = false;
      return {
        args: [
          "--approval-mode", "default",
          "--admin-policy", adminPolicyDir,
          "--policy", userPolicyDir,
          "--extensions", "none",
        ],
        env: {
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: systemDefaultsPath,
        },
        unsetEnv: ["GEMINI_CLI_IDE_WORKSPACE_PATH"],
        diagnostics: {
          effectivePolicy: {
            write: Boolean(policy?.write),
            mode: policy?.write ? "isolated-write-subset" : "isolated-read-only",
          },
          launchFlags: [
            "--approval-mode", "default",
            "--admin-policy", "<isolated-admin-policy>",
            "--policy", "<isolated-user-policy>",
            "--extensions", "none",
          ],
          requiredVersion: GEMINI_CLI_VERSION,
        },
        paths: { root, adminPolicyDir, userPolicyDir, systemSettingsPath, systemDefaultsPath, adminPolicyPath },
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          await fsApi.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
        },
      };
    },
  };
}

export const __testing = { READ_TOOLS, WRITE_TOOLS, policyToml, settingsJson };
