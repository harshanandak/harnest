// audit-20260822.mjs — reproduces the 2026-08-22 Harnest host/repo audit.
// Read-only with respect to every system it inspects; writes only the report file.
// Usage: npm run audit:20260822 [-- --print]
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { harnessLaunch } from "../src/config.mjs";
import { requireNativeCommand } from "../src/launch-command.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.USERPROFILE || process.env.HOME;
if (!home) {
  console.error("audit: cannot resolve home directory (USERPROFILE/HOME unset)");
  process.exit(2);
}
const lines = [];
const record = (status, label, evidence) =>
  lines.push(`${status} ${label}\n    ${String(evidence).trim().split(/\r?\n/).join("\n    ")}`);

async function sh(target, args) {
  try {
    const { command, args: launchArgs = [] } = harnessLaunch(target);
    const { stdout } = await run(requireNativeCommand(command), [...launchArgs, ...args], { timeout: 30_000, windowsHide: true });
    return stdout;
  } catch (error) {
    return error.stdout || error.message.split("\n")[0];
  }
}
const pathExists = async (p) => {
  try { await stat(p); return true; } catch { return false; }
};

async function readJson(p) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

// Expected stamps come from the repo manifests, not hard-coded strings, so a
// version bump does not silently break the standing audit script.
const codexManifest = await readJson(join(root, ".codex-plugin", "plugin.json"));
const claudeManifest = await readJson(join(root, ".claude-plugin", "plugin.json"));
const expectedCodex = codexManifest?.version;
const expectedClaude = claudeManifest?.version;

// --- 1) Codex ---
const codexList = await sh("codex", ["plugin", "list"]);
const codexAc = /harnest@harnest-local\s+installed, enabled\s+(\S+)/.exec(codexList);
record(codexAc?.[1] && codexAc[1] === expectedCodex ? "PASS" : "FAIL",
  "codex plugin list shows harnest@harnest-local at manifest version",
  codexAc ? `version=${codexAc[1]} expected=${expectedCodex}` : "entry not found");
const personalHits = codexList.split(/\r?\n/).filter((l) => /@personal|Marketplace `personal`/i.test(l));
record(personalHits.length === 0 ? "PASS" : "FAIL", "codex has no personal marketplace or @personal entries",
  personalHits.length === 0 ? "0 hits" : personalHits.join("\n"));

// --- Claude ---
const claudeList = await sh("claude", ["plugin", "list"]);
const acIndex = claudeList.indexOf("harnest@harnest-local");
const claudeBlock = acIndex >= 0 ? claudeList.slice(acIndex, acIndex + 300) : "";
const claudeVersion = /Version:\s*(\S+)/.exec(claudeBlock)?.[1];
record(claudeVersion && claudeVersion === expectedClaude && /✔\s*enabled/.test(claudeBlock)
  ? "PASS" : "FAIL",
  "claude plugin list shows harnest at manifest version and enabled",
  claudeBlock ? `version=${claudeVersion} expected=${expectedClaude}` : "entry not found");

// --- OpenCode ---
const ocMcpLines = (await sh("opencode", ["mcp", "list"])).split(/\r?\n/);
const ocAcLine = ocMcpLines.find((l) => l.includes("harnest"));
record(ocAcLine && /connected/i.test(ocAcLine) ? "PASS" : "FAIL",
  "opencode mcp list shows harnest connected", ocAcLine || "entry not found");
for (const [worker, color] of [["opencode-worker", "info"], ["pi-worker", "accent"], ["cursor-worker", "accent"], ["claude-worker", "accent"], ["codex-worker", "accent"], ["gemini-worker", "accent"], ["amp-worker", "accent"], ["acp-worker", "accent"]]) {
  const p = join(home, ".config", "opencode", "agents", `${worker}.md`);
  let body = "";
  try { body = await readFile(p, "utf8"); } catch {}
  record(body.includes("mode: subagent") && body.includes(`color: ${color}`) ? "PASS" : "FAIL",
    `opencode agent ${worker}.md has mode:subagent color:${color}`,
    body ? "frontmatter ok" : "missing file");
}
record(await pathExists(join(home, ".config", "opencode", "skills", "handoff", "SKILL.md")) ? "PASS" : "FAIL",
  "~/.config/opencode/skills/handoff/SKILL.md exists", "file check");
record(await pathExists(join(home, ".config", "opencode", "plugins", "harnest", "index.js")) ? "PASS" : "FAIL",
  "~/.config/opencode/plugins/harnest/index.js exists", "file check");

// --- Pi ---
const piExtPath = join(home, ".pi", "agent", "extensions", "harnest.mjs");
let piExt = "";
try { piExt = await readFile(piExtPath, "utf8"); } catch {}
record(piExt && !piExt.includes("__HARNEST_CORE_URL__") && piExt.includes("file:///") ? "PASS" : "FAIL",
  "pi extension baked (no placeholder, file:/// URL present)",
  piExt ? "placeholder absent, file URL baked" : "extension missing");
let settings = "";
try { settings = await readFile(join(home, ".pi", "agent", "settings.json"), "utf8"); } catch {}
let extArrayOk = false;
try {
  const parsed = JSON.parse(settings);
  const exts = parsed.extensions || [];
  extArrayOk = Array.isArray(exts)
    && exts.filter((e) => String(e).includes("harnest")).length === 1;
} catch {}
record(extArrayOk ? "PASS" : "FAIL", 'pi settings.json "extensions" contains exactly one harnest entry',
  extArrayOk ? "single entry" : "missing/duplicate entries");
record(await pathExists(join(home, ".pi", "agent", "skills", "handoff", "SKILL.md")) ? "PASS" : "FAIL",
  "~/.pi/agent/skills/handoff/SKILL.md exists", "file check");

// --- Residues ---
const residues = [
  ["codex config.toml backup", join(home, ".codex", "config.toml.bak-20260822-personal-cleanup")],
  ["retired marketplace.json backup", join(home, ".agents", "plugins", "marketplace.json.bak-20260822-retired")],
];
for (const [label, p] of residues) record(await pathExists(p) ? "PASS" : "FAIL", `backup exists: ${label}`, p);
let acBaks = [];
try {
  acBaks = (await readdir(home ? join(home, ".pi", "agent") : "."))
    .filter((f) => f.startsWith("settings.json.bak-harnest-"));
} catch {}
record(acBaks.length > 0 ? "PASS" : "FAIL", "pi settings.json.bak-harnest-* backups exist", acBaks.join(", ") || "none");

// stat()-based check: works for directories, unlike readFile which throws EISDIR.
const personalCache = join(home, ".codex", "plugins", "cache", "personal");
record(await pathExists(personalCache)
  ? "INFO personal cache still present — inspect for pinned empty dirs"
  : "INFO personal cache gone (previously pinned empty dirs cleared)",
  "~/.codex/plugins/cache/personal residue state", personalCache);

// --- Report ---
const report = `# Harnest audit — ${new Date().toISOString()}\n\n${lines.join("\n")}\n`;
console.log(report);
if (!process.argv.includes("--print")) {
  await mkdir(join(root, "audit"), { recursive: true });
  const out = join(root, "audit", "latest.md");
  await writeFile(out, report, "utf8");
  console.log(`report written to ${out}`);
}
const fails = lines.filter((l) => l.startsWith("FAIL")).length;
process.exitCode = fails > 0 ? 1 : 0;
