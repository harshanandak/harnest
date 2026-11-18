// Live Pi RPC probe: boots `pi --mode rpc --offline --no-session`, asks for the
// command catalog, and requires the harnest extension to have registered
// harnest_info without any error lines on stderr. Opt-in so CI never depends on a
// live Pi boot: HARNEST_LIVE_PI=1 npm test
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "../src/process.mjs";

test("live pi rpc exposes harnest_info with no errors", { timeout: 60_000, skip: !process.env.HARNEST_LIVE_PI }, async () => {
  const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  // A child that exits early would otherwise crash us via an unhandled EPIPE.
  child.stdin.on("error", () => {});
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));

  child.stdin.write(JSON.stringify({ type: "get_commands", id: "probe" }) + "\n");

  // Wait for the matching reply frame instead of a fixed sleep.
  const deadline = Date.now() + 30_000;
  let reply = null;
  while (Date.now() < deadline && !reply) {
    await new Promise((r) => setTimeout(r, 100));
    reply = out.split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).find((m) => m?.id === "probe" && m.command === "get_commands");
  }
  terminateProcessTree(child);

  assert.ok(reply, `get_commands timed out; stderr=${err.slice(0, 400)}`);
  assert.ok(reply.success, `get_commands failed: ${JSON.stringify(reply).slice(0, 400)}`);
  assert.ok(reply.data.commands.some((c) => c.name === "harnest_info"), "harnest_info not registered by extension");
  // Anchor to line starts on stderr only — incidental substrings elsewhere
  // (command names, banners) are not extension load failures.
  assert.doesNotMatch(err, /^\s*(Error|Uncaught|TypeError)\b/m);
});
