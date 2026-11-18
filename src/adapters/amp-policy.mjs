import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function policyError(message, details = {}) {
  const error = new Error(message);
  error.name = "AmpAdapterError";
  error.details = { kind: "policy", ...details };
  return error;
}

async function exists(path, accessFn = access) {
  try {
    await accessFn(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Amp merges workspace settings over --settings-file and executes project
 * plugins. Reject the project-owned override surfaces we can inspect without
 * opening their contents. Personal/workspace service plugins remain outside
 * the adapter's observable boundary, which is why read-only is unsupported.
 */
export async function findAmpProjectCustomization(cwd, { accessFn = access } = {}) {
  let current = resolve(cwd);
  while (true) {
    const ampDir = join(current, ".amp");
    for (const relative of ["settings.json", "settings.jsonc", "plugins", "tools"]) {
      const candidate = join(ampDir, relative);
      if (await exists(candidate, accessFn)) return { root: current, relative: `.amp/${relative}` };
    }
    if (await exists(join(current, ".git"), accessFn)) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Amp policy preparation aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

export async function prepareAmpPolicy({
  request,
  cwd,
  env = process.env,
  signal,
  inspectCustomization = findAmpProjectCustomization,
} = {}) {
  throwIfAborted(signal);
  if (request?.policy?.write !== true) {
    throw policyError("Amp read-only execution is not enforceable: workspace settings override custom user settings and plugins execute native code", {
      reason: "read-only-unenforceable",
    });
  }
  if (env?.AMP_TOOLBOX) {
    throw policyError("Amp execution is unavailable while AMP_TOOLBOX is configured because external tools bypass the adapter's reviewed launch profile", {
      reason: "external-toolbox",
    });
  }
  let customization;
  try {
    customization = await inspectCustomization(cwd);
  } catch (error) {
    throw policyError("Amp project customization could not be inspected safely", {
      reason: "customization-inspection-failed",
      code: error?.code || null,
      cause: error,
    });
  }
  throwIfAborted(signal);
  if (customization) {
    throw policyError(`Amp project customization ${customization.relative} is incompatible with the reviewed Harnest launch profile`, {
      reason: "project-customization",
      customization: customization.relative,
    });
  }

  const directory = await mkdtemp(join(tmpdir(), "harnest-amp-"));
  const settingsPath = join(directory, "settings.json");
  const settings = {
    "$schema": "https://ampcode.com/cli-settings.schema.json",
    "amp.dangerouslyAllowAll": false,
    "amp.mcpServers": {},
    "amp.mcpPermissions": [
      { matches: { command: "*" }, action: "reject" },
      { matches: { url: "*" }, action: "reject" },
    ],
    "amp.notifications.enabled": false,
    "amp.remoteThreadCreation.enabled": false,
    "amp.runner.autoUpdate.enabled": false,
    "amp.runner.env.enabled": false,
    "amp.skills.disableClaudeCodeSkills": true,
    "amp.skills.disableGlobalAgentsSkills": true,
    "amp.updates.mode": "disabled",
  };
  try {
    throwIfAborted(signal);
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    throwIfAborted(signal);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    args: ["--settings-file", settingsPath],
    env: {
      AMP_SETTINGS_FILE: settingsPath,
      AMP_SKIP_UPDATE_CHECK: "1",
      AMP_REMOTE_CONTROL_TERMINAL: "0",
      NO_COLOR: "1",
    },
    diagnostics: {
      effectivePolicy: {
        write: true,
        isolation: "best-effort-native-settings",
      },
      launchFlags: ["--settings-file"],
      limitations: [
        "read-only policy is unsupported",
        "custom settings reduce ambient behavior but do not contain personal or workspace plugins",
        "local attached execution inherits the Amp account and operating-system user boundary",
      ],
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export default prepareAmpPolicy;
