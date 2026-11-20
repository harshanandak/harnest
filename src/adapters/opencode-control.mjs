import { spawnNativeCommand } from "../launch-command.mjs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { OpenCode } from "@opencode-ai/client";
import { terminateProcessTree } from "../process.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 40;

export class OpenCodeControlError extends Error {
  constructor(message, kind = "control", details = {}) {
    super(message);
    this.name = "OpenCodeControlError";
    this.details = { kind, ...details };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(host = "127.0.0.1") {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new OpenCodeControlError("could not allocate a private OpenCode port", "not-ready");
  return port;
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, "")}${path}`;
}

function responseOk(response) {
  return Boolean(response && (response.ok === true || (Number(response.status) >= 200 && Number(response.status) < 300)));
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isFinite(status) ? status : null;
}

function modelParts(route = {}) {
  const provider = String(route.provider || "").trim();
  let model = String(route.model || "").trim();
  if (provider && model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1);
  const variant = route.variant || (typeof route.thinking === "string" ? route.thinking : undefined);
  return { provider, model, variant: variant ? String(variant) : undefined };
}

export class OpenCodeControl {
  constructor(options = {}) {
    this.options = options;
    this.spawnFn = options.spawnFn || spawnNativeCommand;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.clientFactory = options.clientFactory || OpenCode.make;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.pollMs = options.pollMs || DEFAULT_POLL_MS;
    this.serverChild = null;
    this.serverUrl = null;
    this.sessionId = null;
    this.ready = false;
    this.serverClosed = false;
    this.serverExit = null;
    this.serverStderr = "";
    this.serverPassword = options.serverPassword || null;
    this.serverUsername = options.serverUsername || "opencode";
    this.client = null;
    this.closePromise = null;
  }

  async start({ request, launch, env, signal, serverUrl } = {}) {
    this.serverUrl = serverUrl || request?.route?.serverUrl || null;
    const serverEnv = env || process.env;
    // A spawn environment that already carries OPENCODE_SERVER_PASSWORD (or
    // OPENCODE_PASSWORD) makes the server adopt it silently - it never prints
    // "server password ...", so readiness probes must authenticate with it.
    if (!this.serverPassword) {
      this.serverPassword = serverEnv.OPENCODE_SERVER_PASSWORD || serverEnv.OPENCODE_PASSWORD || null;
    }
    if (this.serverUrl) {
      await this.waitReady(signal);
      this.ready = true;
      this.client = this.clientFactory({ baseUrl: this.serverUrl, headers: this.authHeaders() });
      return this.serverUrl;
    }

    const host = "127.0.0.1";
    const port = this.options.port || await freePort(host);
    const launchConfig = typeof launch === "string" ? { command: launch, args: [] } : launch;
    const args = [
      ...(Array.isArray(launchConfig.args) ? launchConfig.args : []),
      "serve", "--hostname", host, "--port", String(port),
    ];
    const child = this.spawnFn(launchConfig.command, args, {
      cwd: request?.cwd,
      env: serverEnv,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.serverChild = child;
    this.serverClosed = false;
    this.serverExit = null;
    this.serverStderr = "";
    let output = "";
    child.stdout?.on?.("data", (chunk) => {
      output += Buffer.from(chunk).toString("utf8");
      const match = output.match(/server password\s+([^\s\r\n]+)/i);
      if (match) this.serverPassword = match[1];
      if (output.length > 4_096) output = output.slice(-4_096);
    });
    child.stderr?.on?.("data", (chunk) => {
      this.serverStderr += Buffer.from(chunk).toString("utf8");
      if (this.serverStderr.length > 4_096) this.serverStderr = this.serverStderr.slice(-4_096);
    });
    child.once?.("close", (code, signalName) => {
      this.serverExit ||= { code, signal: signalName, error: null };
      this.serverClosed = true;
    });
    child.once?.("error", (error) => {
      this.serverExit = { code: error?.code ?? null, signal: null, error };
      this.serverClosed = true;
    });
    this.serverUrl = `http://${host}:${port}`;
    try {
      await this.waitReady(signal);
      this.ready = true;
      this.client = this.clientFactory({ baseUrl: this.serverUrl, headers: this.authHeaders() });
      return this.serverUrl;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async waitReady(signal) {
    if (!this.serverUrl) throw new OpenCodeControlError("OpenCode server URL is unavailable", "not-ready");
    const deadline = performance.now() + this.timeoutMs;
    let lastError = null;
    while (true) {
      if (signal?.aborted) throw new OpenCodeControlError("OpenCode server readiness was aborted", "aborted", { aborted: true });
      if (this.serverClosed) {
        const exit = this.serverExit || {};
        const message = exit.error
          ? `OpenCode server failed to start: ${exit.error.message}`
          : "OpenCode server exited before becoming ready";
        throw new OpenCodeControlError(message, "not-ready", {
          code: exit.code ?? null,
          signal: exit.signal ?? null,
          stderr: this.serverStderr || null,
        });
      }
      if (performance.now() >= deadline) break;
      // OpenCode V2 serves health at /global/health (2.2.1 returns 404 for an
      // authenticated /api/health). Keep /api/health as a fallback.
      for (const path of ["/global/health", "/api/health"]) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0 || signal?.aborted || this.serverClosed) break;
        const timeout = AbortSignal.timeout(remaining);
        const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          const response = await this.fetchFn(joinUrl(this.serverUrl, path), {
            method: "GET", headers: this.authHeaders(), signal: probeSignal,
          });
          if (responseOk(response) && !probeSignal.aborted && performance.now() < deadline) return response;
          lastError = new Error(`${path} returned HTTP ${responseStatus(response) ?? "unknown"}`);
        } catch (error) {
          lastError = error;
        }
      }
      const remaining = deadline - performance.now();
      if (remaining > 0 && !signal?.aborted && !this.serverClosed) await sleep(Math.min(this.pollMs, remaining));
    }
    throw new OpenCodeControlError("OpenCode server did not become ready", "not-ready", {
      cause: lastError?.message || null,
    });
  }

  authHeaders() {
    if (!this.serverPassword) return undefined;
    return {
      authorization: `Basic ${Buffer.from(`${this.serverUsername}:${this.serverPassword}`).toString("base64")}`,
    };
  }

  setSessionId(sessionId) {
    if (typeof sessionId === "string" && sessionId.trim()) this.sessionId = sessionId.trim();
  }

  async waitForSession(signal) {
    const started = Date.now();
    while (!this.sessionId && Date.now() - started < this.timeoutMs) {
      if (signal?.aborted) throw new OpenCodeControlError("OpenCode session wait was aborted", "aborted", { aborted: true });
      if (this.serverClosed) throw new OpenCodeControlError("OpenCode server is no longer running", "not-ready");
      await sleep(this.pollMs);
    }
    if (!this.sessionId) throw new OpenCodeControlError("OpenCode session is not available yet", "not-ready");
    return this.sessionId;
  }

  async #send(command, sessionId) {
    const session = this.client?.session;
    if (!session) throw new OpenCodeControlError("OpenCode V2 client is not ready", "not-ready");
    let model = null;
    if (command.kind === "reroute") {
      model = modelParts(command.route);
      if (!model.provider || !model.model) throw new OpenCodeControlError("V2 reroute requires provider and model", "invalid-control");
      await session.switchModel({
        sessionID: sessionId,
        model: { providerID: model.provider, id: model.model, ...(model.variant ? { variant: model.variant } : {}) },
      });
    }
    if (command.message) {
      // stop() clears the client. A run that ended during switchModel must not
      // receive a prompt afterwards.
      const live = this.client?.session;
      if (!live) {
        throw new OpenCodeControlError(model
          ? "OpenCode switched the model, but the run ended before the message was sent"
          : "OpenCode V2 client is not ready", "not-ready", model ? { modelSwitchApplied: true, model } : {});
      }
      try {
        await live.prompt({
          sessionID: sessionId,
          id: `msg_${randomUUID().replaceAll("-", "")}`,
          text: command.message,
          delivery: command.delivery === "follow_up" ? "queue" : "steer",
        });
      } catch {
        throw new OpenCodeControlError(model
          ? "OpenCode switched the model and did not confirm prompt delivery"
          : "OpenCode did not confirm prompt delivery", "control", {
          uncertain: true,
          ...(model ? { modelSwitchApplied: true, model } : {}),
        });
      }
    }
    return {
      commandId: command.commandId,
      harnessVersion: "v2",
      sessionId,
      delivery: command.delivery,
      persisted: true,
      model,
    };
  }

  async control(command, signal) {
    if (!this.ready || !this.serverUrl) throw new OpenCodeControlError("OpenCode control server is not ready", "not-ready");
    const sessionId = await this.waitForSession(signal);
    return this.#send(command, sessionId);
  }

  async stop() {
    this.ready = false;
    this.client = null;
    const child = this.serverChild;
    this.serverChild = null;
    if (!child || this.serverClosed) return;
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise((resolve) => {
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      child.once?.("close", done);
      timer = setTimeout(done, 2_000);
      terminateProcessTree(child);
    }).finally(() => { this.closePromise = null; });
    return this.closePromise;
  }
}

export default OpenCodeControl;
