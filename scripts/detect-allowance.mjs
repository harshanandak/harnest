// Allowance auto-detection: read-only native probes per harness.
// Codex quota comes from app-server account/rateLimits/read without inference;
// every other harness's account quota remains unknown and manual.
//
// Auth presence and provider readiness remain separate from quota. Nothing
// here spends a model call or mutates credentials or routing policy.
//
// Manual values remain unchanged. Auth probes never become headroom.
// Subsidies are suggest-only:
// billing assumptions are never written automatically.
//
// Usage:
//   node scripts/detect-allowance.mjs [--apply [--out path] [--yes]]
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/process.mjs";
import { harnessLaunch } from "../src/config.mjs";
import { CODEX_QUOTA_SOURCE, probeCodexQuota } from "../src/codex-quota.mjs";

export const PI_PROVIDERS = ["anthropic", "openrouter", "openai-codex", "deepseek", "openai"];
const PROBE_TIMEOUT_MS = 15_000;

function defaultPolicyPath() {
  return process.env.HARNEST_ROUTING_POLICY || join(homedir(), ".harnest", "routing.json");
}

async function defaultRun(target, args, timeoutMs = PROBE_TIMEOUT_MS) {
  // Same resolution the adapters use: direct node entrypoints on Windows,
  // never the quote-mangling .ps1 shims. Honors HARNEST_* overrides.
  let launch;
  try {
    launch = harnessLaunch(target);
  } catch (error) {
    return { ok: false, stdout: "", error: error?.message || String(error) };
  }
  try {
    const { stdout, stderr } = await runProcess(launch.command, [...(launch.args || []), ...args], { timeoutMs });
    // Status lines surface on either stream depending on harness; parse both.
    return { ok: true, stdout: `${stdout || ""}\n${stderr || ""}` };
  } catch (error) {
    return { ok: false, stdout: `${error?.details?.stdout || ""}\n${error?.details?.stderr || ""}`, error: error?.message || String(error) };
  }
}

function parseCodexLogin(stdout) {
  if (/logged in using chatgpt/i.test(stdout)) return "chatgpt";
  if (/not logged in|log in to|no account|please run.*login/i.test(stdout)) return "none";
  return "unknown";
}

function parseCursorStatus(stdout) {
  if (/logged in as/i.test(stdout)) return "subscription";
  if (/not logged in|logged out|please.*login/i.test(stdout)) return "none";
  return "unknown";
}

function parsePiCheck(stdout, ok = true) {
  // Probe failure means readiness could not be established; it is not quota.
  if (!ok) return { ready: false, authType: null, reason: "probe-failed" };
  try {
    const value = JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1));
    if (value && typeof value === "object" && typeof value.status === "string") {
      return { ready: value.status === "ready", authType: value.authType || null, reason: value.reason || null };
    }
  } catch { /* fall through to unknown */ }
  return { ready: false, authType: null, reason: "unparseable" };
}

export async function detectAllowance(run = defaultRun, { codexQuotaProbe = probeCodexQuota } = {}) {
  // Login-status probes boot whole CLI runtimes; allow cold starts.
  const [codexOut, cursorOut, codexQuota] = await Promise.all([
    run("codex", ["login", "status"], 30_000),
    run("cursor", ["status"], 30_000),
    Promise.resolve()
      .then(() => codexQuotaProbe({ timeoutMs: PROBE_TIMEOUT_MS }))
      .catch(() => ({ status: "unknown", source: CODEX_QUOTA_SOURCE, observedAt: Date.now(), reason: "probe-failed" })),
  ]);
  const piProviders = {};
  for (const provider of PI_PROVIDERS) {
    // Sequential: pi auth checks serialize on the credential store anyway.
    const probed = await run("pi", ["auth", "check", "--provider", provider, "--json", "--no-refresh"]);
    piProviders[provider] = parsePiCheck(probed.stdout, probed.ok);
  }
  return {
    codex: {
      auth: parseCodexLogin(codexOut.stdout),
      signal: codexOut.ok ? "login-status" : "unavailable",
      quota: codexQuota,
    },
    cursor: { auth: parseCursorStatus(cursorOut.stdout), signal: cursorOut.ok ? "status" : "unavailable" },
    claude: { signal: "none", note: "claude doctor reports install health only; no auth/quota signal" },
    opencode: { signal: "none", note: "no clean read-only auth probe; manual stays" },
    pi: { providers: piProviders },
    amp: { signal: "none", note: "no verified read-only auth/quota probe; unknown" },
  };
}

// Auth readiness says nothing about remaining allowance, including on failure.
// Keep this compatibility export unknown until a real quota signal exists.
export function piHeadroom(detection, policy) {
  return null;
}

export function subsidySuggestions(detection, policy) {
  const suggestions = [];
  const recorded = policy?.subscriptions || {};
  if (detection.codex.auth === "chatgpt" && recorded.codex?.subsidy !== 1) {
    suggestions.push('subscriptions.codex={plan:"chatgpt",subsidy:1} (ChatGPT login present; record via setup-routing)');
  }
  if (detection.cursor.auth === "subscription" && recorded.cursor?.subsidy !== 1) {
    suggestions.push('subscriptions.cursor={plan:"sub",subsidy:1} (Cursor login present; record via setup-routing)');
  }
  return suggestions;
}

export async function applyAutoHeadroom() {
  return { applied: false, reason: "automatic policy writes are disabled; native Codex quota is reported read-only and manual pressure remains authoritative" };
}

const args = process.argv.slice(2);
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && (args.includes("--help") || args.includes("-h"))) {
  console.log([
    "Usage: node scripts/detect-allowance.mjs [--apply [--out path] [--yes]]",
    "  Read-only probes: ChatGPT/Cursor login presence, pi readiness, Codex native quota.",
    "  Codex quota uses app-server account/rateLimits/read without inference.",
    "  --apply does not overwrite routing policy; manual set-pressure remains authoritative.",
  ].join("\n"));
  process.exit(0);
}

if (isMain) {
  const detection = await detectAllowance();
  const outPath = (() => {
    const index = args.indexOf("--out");
    if (index < 0) return defaultPolicyPath();
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      console.error("--out requires a path value");
      process.exit(1);
    }
    return value;
  })();
  let policy = {};
  let policyCorrupt = false;
  if (existsSync(outPath)) {
    try {
      policy = JSON.parse(await readFile(outPath, "utf8"));
    } catch {
      policy = {};
      policyCorrupt = true;
    }
  }
  const headroom = piHeadroom(detection, policy);
  const readyProviders = Object.entries(detection.pi.providers)
    .filter(([, p]) => p.ready).map(([name, p]) => `${name}(${p.authType || "?"})`);
  const downProviders = Object.entries(detection.pi.providers)
    .filter(([, p]) => !p.ready && p.reason !== "unparseable").map(([name]) => name);
  console.log([
    "allowance auto-detect (read-only; manual policy stays authoritative):",
    `  codex: auth=${detection.codex.auth} (${detection.codex.signal})`,
    detection.codex.quota?.status === "available"
      ? `  codex quota: used=${detection.codex.quota.usedPercent ?? "unknown"}% headroom=${detection.codex.quota.headroom ?? "unknown"} reset=${detection.codex.quota.resetsAt ?? "unknown"} source=${detection.codex.quota.source}`
      : `  codex quota: unknown (${detection.codex.quota?.reason || "unavailable"}) source=${detection.codex.quota?.source || CODEX_QUOTA_SOURCE}`,
    `  cursor: auth=${detection.cursor.auth} (${detection.cursor.signal})`,
    `  pi: ready=[${readyProviders.join(", ") || "none"}] down=[${downProviders.join(", ") || "none"}]`,
    `  pi headroom=${headroom === null ? "no signal" : headroom}`,
    "  cursor/pi/claude/generic-opencode/amp quota: unknown — manual stays",
  ].join("\n"));
  for (const suggestion of subsidySuggestions(detection, policy)) {
    console.log(`  suggest ${suggestion}`);
  }
  if (args.includes("--apply")) {
    if (policyCorrupt) {
      console.error(`${outPath} is not valid JSON; refusing to apply (fix or delete it first)`);
      process.exit(1);
    }
    if (headroom === null) {
      console.log("nothing to apply: no pi signal");
    } else {
      const previousRaw = existsSync(outPath) ? await readFile(outPath, "utf8") : null;
      // Backup BEFORE the write: a crash between write and backup must not
      // be the thing that destroys the only restore point.
      if (previousRaw !== null && !args.includes("--yes") && !args.includes("-y")) {
        const backup = `${outPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await writeFile(backup, previousRaw);
        console.log(`backed up previous policy to ${backup}`);
      }
      const result = await applyAutoHeadroom({ policyPath: outPath, detection, headroom });
      if (!result.applied) {
        console.log(result.reason);
      } else {
        console.log(`auto headroom recorded in ${outPath}: pi=${headroom} (source=auto; manual set-pressure wins)`);
      }
    }
  }
}
