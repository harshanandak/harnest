import { ClaudeAdapter } from "./claude.mjs";
import { CodexAdapter } from "./codex.mjs";
import { CursorAdapter } from "./cursor.mjs";
import { AmpAdapter } from "./amp.mjs";
import { PiAdapter } from "./pi.mjs";
import { ACPAdapter } from "./acp.mjs";
import { routeControlError } from "../protocol.mjs";

class LazyOpenCodeAdapter {
  constructor(options) {
    this.options = options;
    this.adapter = null;
  }

  load() {
    // Share the instance promise so run and concurrent controls use one session.
    this.adapter ??= import("./opencode.mjs")
      .then(({ OpenCodeAdapter }) => new OpenCodeAdapter(this.options));
    return this.adapter;
  }

  async run(...args) {
    return (await this.load()).run(...args);
  }

  async control(...args) {
    return (await this.load()).control(...args);
  }
}

const SESSION_ADAPTERS = {
  claude: () => import("./claude-session.mjs"),
  codex: () => import("./codex-session.mjs"),
  cursor: () => import("./cursor-session.mjs"),
};

export class LazySessionAdapter {
  constructor(load, options) {
    this.loader = load;
    this.options = options;
  }

  load() {
    this.adapter ??= this.loader().then(({ default: Adapter, SESSION_CAPABILITIES }) => {
      this.reportedCapabilities = SESSION_CAPABILITIES;
      this.instance = new Adapter(this.options);
      return this.instance;
    });
    return this.adapter;
  }

  get capabilities() { return this.instance?.capabilities ?? this.reportedCapabilities; }

  async run(request, hooks = {}) {
    const check = () => {
      if (this.closed || hooks.signal?.aborted) throw Object.assign(new Error("session launch cancelled"), { details: { kind: "abort", aborted: true } });
    };
    check();
    const adapter = await this.load();
    check();
    return adapter.run(request, hooks);
  }
  async control(...args) { return (await this.load()).control(...args); }
  async close() {
    this.closed = true;
    // An import failure is reported by run(); there is no native owner to close.
    const adapter = this.adapter ? await this.adapter.catch(() => null) : null;
    await adapter?.close?.();
  }
}

export function createAdapter(target, options = {}, request = null) {
  const controlError = routeControlError(target, request?.route, request?.execution?.transport);
  if (controlError) throw Object.assign(new TypeError(controlError), { details: { kind: "policy" } });
  if (request?.execution?.transport === "session") {
    if (!SESSION_ADAPTERS[target]) {
      throw Object.assign(new TypeError("session transport is supported only for claude, codex, or cursor"), {
        details: { kind: "policy", target, transport: "session" },
      });
    }
    return new LazySessionAdapter(SESSION_ADAPTERS[target], options[target]);
  }
  if (target === "opencode") return new LazyOpenCodeAdapter(options.opencode);
  if (target === "pi") return new PiAdapter(options.pi);
  if (target === "cursor") return new CursorAdapter(options.cursor);
  if (target === "claude") return new ClaudeAdapter(options.claude);
  if (target === "codex") return new CodexAdapter(options.codex);
  if (target === "amp") return new AmpAdapter(options.amp);
  if (target === "acp") return new ACPAdapter(options.acp);
  throw new TypeError(`unsupported target: ${target}`);
}
