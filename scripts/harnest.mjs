#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const usage = `Usage: harnest <command> [options]

  setup <host>          Connect a lead host
  setup remove <host>   Disconnect a lead host
  doctor               Check Harnest and lead connections
  daemon               Manage the shared daemon and login item
  acp                  Manage registered ACP agents
  routing setup        Configure routing preferences
  --help               Show this help
  --version            Show the installed version`;

const scripts = new Map([
  ["setup", "setup.mjs"],
  ["doctor", "doctor.mjs"],
  ["daemon", "daemon.mjs"],
  ["acp", "acp-registry.mjs"],
  ["routing setup", "setup-routing.mjs"],
]);
const [command, ...args] = process.argv.slice(2);
const name = command === "routing" ? `routing ${args.shift()}` : command;
const entrypoint = scripts.get(name);
if (!command || command === "--help" || command === "-h") {
  console.log(usage);
} else if (command === "--version" || command === "-v") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else if (entrypoint) {
  const script = new URL(entrypoint, import.meta.url);
  process.argv.splice(1, process.argv.length - 1, fileURLToPath(script), ...args);
  await import(script.href);
} else {
  console.error(usage);
  process.exitCode = 1;
}
