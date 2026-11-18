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

function normalizeVersion(value) {
  return value === "v2" ? "v2" : "v1";
}

function modelParts(route = {}) {
  const provider = String(route.provider || "").trim();
  let model = String(route.model || "").trim();
  if (provider && model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1);
  const variant = route.variant || (typeof route.thinking === "string" ? route.thinking : undefined);
  return { provider, model, variant: variant ? String(variant) : undefined };
}

/**
 * Owns the short-lived private OpenCode server used by an adapter run. V1 is
 * controlled over the legacy HTTP surface; V2 uses the generated Promise
 * client and its durable inbox delivery modes.
 */
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
    this.version = "v1";
    this.ready = false;
    this.serverClosed = false;
    this.serverExit = null;
    this.serverStderr = "";
    this.serverPassword = options.serverPassword || null;
    this.serverUsername = options.serverUsername || "opencode";
    this.client = null;
    this.closePromise = null;
  }

  async start({ request, version, launch, env, signal, serverUrl } = {}) {
    this.version = normalizeVersion(version || request?.route?.harnessVersion);
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
      this.client = this.version === "v2" ? this.clientFactory({ baseUrl: this.serverUrl, headers: this.authHeaders() }) : null;
      return this.serverUrl;
    }

    const host = "127.0.0.1";
    const port = this.options.port || await freePort(host);
    const launchConfig = typeof launch === "string" ? { command: launch, args: [] } : (launch || { command: "opencode", args: [] });
    const args = [
      ...(Array.isArray(launchConfig.args) ? launchConfig.args : []),
      "serve", "--hostname", host, "--port", String(port),
    ];
    if (this.version === "v1") args.push("--pure");
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
      this.client = this.version === "v2" ? this.clientFactory({ baseUrl: this.serverUrl, headers: this.authHeaders() }) : null;
      return this.serverUrl;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async waitReady(signal) {
    if (!this.serverUrl) throw new OpenCodeControlError("OpenCode server URL is unavailable", "not-ready");
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < this.timeoutMs) {
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
      for (const path of this.version === "v2" ? ["/api/health", "/global/health"] : ["/global/health", "/api/health"]) {
        try {
          const response = await this.fetchFn(joinUrl(this.serverUrl, path), { method: "GET", headers: this.authHeaders(), signal });
          if (responseOk(response)) return response;
          lastError = new Error(`health returned HTTP ${responseStatus(response) ?? "unknown"}`);
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(this.pollMs);
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

  async #v2Request(command, sessionId) {
    if (!this.client?.session) throw new OpenCodeControlError("OpenCode V2 client is not ready", "not-ready");
    let model = null;
    if (command.kind === "reroute") {
      model = modelParts(command.route);
      if (!model.provider || !model.model) throw new OpenCodeControlError("V2 reroute requires provider and model", "invalid-control");
      await this.client.session.switchModel({
        sessionID: sessionId,
        model: { providerID: model.provider, id: model.model, ...(model.variant ? { variant: model.variant } : {}) },
      });
    }
    if (command.message) {
      await this.client.session.prompt({
        sessionID: sessionId,
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        text: command.message,
        delivery: command.delivery === "follow_up" ? "queue" : "steer",
      });
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
    if (this.version === "v1") {
      throw new OpenCodeControlError("OpenCode V1 live control is unsafe in 1.18.18; use current OpenCode or Pi", "unsupported-control");
    }
    const sessionId = await this.waitForSession(signal);
    return this.#v2Request(command, sessionId);
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
