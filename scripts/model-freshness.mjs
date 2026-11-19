#!/usr/bin/env node
/**
 * model-freshness - compare the tracked model families (src/model-families.mjs)
 * against the live `opencode models` catalog. Anything newer than the pinned
 * LATEST entry is reported, so routing never silently lags a release.
 *
 * Usage: node scripts/model-freshness.mjs [--catalog <file>]
 * Exit 0 when current, 1 when an update is available.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { harnessLaunch, isOpenCodeV2Version } from "../src/config.mjs";
import { requireNativeCommand } from "../src/launch-command.mjs";
import { freshnessReport } from "../src/model-families.mjs";

export function liveCatalog() {
  const launch = harnessLaunch("opencode");
  const command = requireNativeCommand(launch.command);
  const args = launch.args ?? [];
  const version = execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 5_000 });
  if (!isOpenCodeV2Version(version)) throw new Error("OpenCode V2 is required for model discovery");
  return execFileSync(command, [...args, "models"], {
    encoding: "utf8", timeout: 60_000,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const catalogIndex = args.indexOf("--catalog");
  const catalog = catalogIndex === -1
    ? liveCatalog()
    : await readFile(args[catalogIndex + 1], "utf8");
  const report = freshnessReport(catalog);
  if (report.current) {
    console.log("model families current");
    return 0;
  }
  for (const update of report.updates) {
    if (update.missing) console.log(`MISSING ${update.family}: pinned ${update.pinned} is not in the catalog`);
    else console.log(`UPDATE ${update.family}: pinned ${update.pinned} -> catalog has ${update.newest}`);
  }
  return 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`model-freshness: ${error.message}`);
    process.exit(1);
  });
}
