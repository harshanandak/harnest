#!/usr/bin/env node
import { emitKeypressEvents, createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Companion } from "../src/companion.mjs";
import { lazyDynamicRunner } from "../src/dynamic-tools.mjs";
import { WorkflowRegistry } from "../src/workflow-registry.mjs";
import { redactSecrets } from "../src/process.mjs";
import { DynamicViewController, renderDynamicView, cleanText } from "../src/dynamic-view.mjs";

export const HELP = "Commands: pause, continue, stop, stop-agent, restart-agent [approve-writes], resume [approve-writes], steer <message>, reroute <route JSON>, filter <state|all>, next. Save/invoke scripts with handoff_dynamic_save/invoke. Up/down select; Enter opens; Esc returns; q quits.";

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--state-dir", "--dynamic-state-dir"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a directory`);
      result[arg === "--state-dir" ? "stateDir" : "dynamicStateDir"] = value;
    } else if (["--readonly", "--json", "--once"].includes(arg)) result[arg.slice(2)] = true;
    else if (arg.startsWith("--") || result.selector) throw new Error(`Unexpected argument: ${arg}`);
    else result.selector = arg;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const options = { readOnly: Boolean(parsed.readonly) };
  const stateDir = parsed.stateDir;
  const companion = new Companion({ stateDir });
  const runner = lazyDynamicRunner({ companion, stateDir: parsed.dynamicStateDir });
  const registry = new WorkflowRegistry();
  const view = new DynamicViewController({ ...options, runner, companion, registry });
  const selector = parsed.selector;
  if (selector) await view.open(selector);
  else await view.refresh();
  const frame = () => renderDynamicView(view, { width: process.stdout.columns || 110, height: process.stdout.rows || 36 });
  if (argv.includes("--json")) { console.log(JSON.stringify(view.run ?? view.runs, null, 2)); return; }
  if (argv.includes("--once") || !process.stdin.isTTY || !process.stdout.isTTY) { console.log(frame()); return; }
  let stopped = false;
  let busy = false;
  let detail = null;
  let detailOffset = 0;
  let timer;
  const draw = () => {
    const rows = process.stdout.rows || 36;
    const content = detail ? detail.split("\n").slice(detailOffset, detailOffset + rows - 2).join("\n") + "\nUp/down: scroll | Esc: back | full output: handoff_trace/result" : frame();
    process.stdout.write(`\x1b[2J\x1b[H${content}`);
  };
  const finish = () => {
    stopped = true;
    clearInterval(timer);
    process.stdin.off("keypress", keypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\n");
  };
  const act = async (work) => {
    if (busy || stopped) return;
    busy = true;
    try { await work(); } catch (error) { view.message = cleanText(error.message); }
    finally { busy = false; if (!stopped) draw(); }
  };
  async function command() {
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\n");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const line = await new Promise((resolve) => input.question(": ", resolve));
    input.close();
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?25l");
    const [action, ...parts] = line.trim().split(/\s+/);
    if (action === "filter") { view.run = null; view.historyCursor = undefined; view.filter = parts[0] === "all" ? undefined : parts[0]; await view.refresh(); }
    else if (action === "next") await view.refresh({ next: true });
    else if (action === "back") await view.refresh({ previous: true });
    else await view.control(action, {
      ...(action === "steer" ? { message: parts.join(" ") } : {}),
      ...(action === "reroute" ? { route: JSON.parse(parts.join(" ")) } : {}),
      ...(["resume", "restart-agent"].includes(action) && parts.includes("approve-writes") ? { approveWrites: true } : {}),
    });
  }
  function keypress(text, key = {}) {
    if (busy) return;
    if (text === "q" || key.ctrl && key.name === "c") { finish(); return; }
    void act(async () => {
      if (key.name === "up" || text === "k") { if (detail) detailOffset = Math.max(0, detailOffset - 1); else view.select(-1); }
      else if (key.name === "down" || text === "j") { if (detail) detailOffset = Math.min(Math.max(0, detail.split("\n").length - 1), detailOffset + 1); else view.select(1); }
      else if (key.name === "escape") { if (detail) detail = null; else { view.run = null; await view.refresh(); } }
      else if (key.name === "return") {
        if (view.run) { detail = redactSecrets(JSON.stringify(await view.detail(), null, 2)).split("\n").map((line) => cleanText(line, 160)).slice(0, 2000).join("\n"); detailOffset = 0; }
        else if (view.selectedId) await view.open();
      } else if (text === "?") detail = HELP;
      else if (text === ":") await command();
      else if (text === "p") await view.control("pause");
      else if (text === "c") await view.control("continue");
      else if (text === "s") await view.control("stop");
      else if (text === "r") await view.refresh();
    });
  }
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", keypress);
  process.stdout.write("\x1b[?25l");
  timer = setInterval(() => { void act(() => view.refresh()); }, 1000);
  draw();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(cleanText(error.message)); process.exitCode = 1; });
}
