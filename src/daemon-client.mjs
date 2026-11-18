import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DAEMON_PORT, VERSION, clientPort, daemonAddress, daemonProof, readDaemonToken } from "./daemon-settings.mjs";
import { withoutHarnestToken } from "./daemon-env.mjs";

const STARTUP_MS = 8000;
const loopback = new Agent({ keepAlive: true });

function exchange(url, { headers, method, body, signal, agent = loopback } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, signal, agent }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      } catch { reject(new Error("Invalid response from the Harnest daemon")); }
    });
    req.on("error", reject);
    for (const [name, value] of Object.entries(headers ?? {})) req.setHeader(name, value);
    req.end(body);
  });
}

async function inspect(port) {
  let token;
  try { token = await readDaemonToken(); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const base = daemonAddress(port);
  const challenge = randomBytes(32).toString("hex");
  const probe = await exchange(`${base}/proof?challenge=${challenge}`, {
    signal: AbortSignal.timeout(500),
  }).catch(() => null);
  const proof = probe?.body?.proof;
  if (probe?.status !== 200 || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof) ||
      !timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(daemonProof(token, challenge), "hex"))) return null;
  const health = await exchange(`${base}/health`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500),
  }).catch(() => null);
  return health?.status === 200 && health.body?.ready === true && typeof health.body.version === "string"
    ? health.body : null;
}

export async function daemonStatus({ port = clientPort() } = {}) {
  return await inspect(port) ?? { ready: false, version: null };
}

export async function stopDaemon({ port = clientPort(), expectedVersion } = {}) {
  const health = await inspect(port);
  if (!health) return "stopped";
  if (expectedVersion && health.version !== expectedVersion) return "replaced";
  const response = await exchange(`${daemonAddress(port)}/stop`, {
    method: "POST", headers: { Authorization: `Bearer ${await readDaemonToken()}`, "If-Match": `"${health.version}"` },
    signal: AbortSignal.timeout(500),
  });
  if (response.status === 409) return "busy";
  if (response.status === 412) return "replaced";
  if (response.status === 503) return "stopping";
  if (response.status !== 200) throw new Error("Harnest daemon could not stop");
  return "stopping";
}

function isOlder(left, right) {
  const parts = (version) => /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+.*)?$/.exec(version);
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return false;
  for (const index of [1, 2, 3]) {
    if (+a[index] !== +b[index]) return +a[index] < +b[index];
  }
  if (!a[4] || !b[4]) return Boolean(a[4] && !b[4]);
  const ap = a[4].split(".");
  const bp = b[4].split(".");
  for (let index = 0; index < Math.min(ap.length, bp.length); index++) {
    if (ap[index] === bp[index]) continue;
    const an = /^\d+$/.test(ap[index]);
    const bn = /^\d+$/.test(bp[index]);
    if (an && bn) return +ap[index] < +bp[index];
    if (an !== bn) return an;
    return ap[index] < bp[index];
  }
  return ap.length < bp.length;
}

async function ensure({ port, version }) {
  const deadline = Date.now() + STARTUP_MS;
  const existing = await inspect(port);
  if (existing && !isOlder(existing.version, version)) return existing;
  if (existing) {
    const state = await stopDaemon({ port, expectedVersion: existing.version });
    if (state === "busy") {
      process.stderr.write("Harnest daemon upgrade deferred while work is active.\n");
      return existing;
    }
    // Wait for the old listener to release the singleton before spawning.
    while (Date.now() < deadline) {
      const health = await inspect(port);
      if (health && !isOlder(health.version, version)) return health;
      try {
        await exchange(`${daemonAddress(port)}/health`, { signal: AbortSignal.timeout(250) });
      } catch (error) {
        if (error.code === "ECONNREFUSED") break;
      }
      await delay(75);
    }
  }
  const fixtureArgs = port === DAEMON_PORT ? [] : ["--fixture-port", String(port)];
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.mjs", import.meta.url)), ...fixtureArgs], {
    detached: true, windowsHide: true, stdio: "ignore", env: withoutHarnestToken(process.env),
  });
  let spawnFailed = false;
  child.on("error", () => { spawnFailed = true; });
  child.unref();
  while (!spawnFailed && Date.now() < deadline) {
    const health = await inspect(port);
    if (health) return health;
    await delay(75);
  }
  throw new Error("Harnest daemon did not become ready. Check the loopback port and daemon directory permissions.");
}

const starting = new Map();

export function ensureDaemon({ port = clientPort(), version = VERSION } = {}) {
  if (starting.has(port)) return starting.get(port);
  const pending = ensure({ port, version }).finally(() => starting.delete(port));
  starting.set(port, pending);
  return pending;
}

export function createDaemonClient({ port = clientPort(), directory } = {}) {
  let id = 0;
  let token;
  const agent = new Agent({ keepAlive: true });
  return {
    close: () => agent.destroy(),
    async rpc(message, protocolVersion) {
      token ??= await readDaemonToken(directory);
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      };
      const revision = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? protocolVersion;
      if (revision) headers["MCP-Protocol-Version"] = revision;
      if (revision >= "2026-07-28") {
        headers["Mcp-Method"] = message.method;
        if (message.method === "tools/call") headers["Mcp-Name"] = message.params.name;
      }
      const response = await exchange(`${daemonAddress(port)}/mcp`, {
        method: "POST", headers, body: JSON.stringify(message), agent,
      });
      if (response.status === 401) token = undefined;
      if (response.status >= 400 && response.body?.jsonrpc !== "2.0") {
        throw new Error(`Harnest daemon returned HTTP ${response.status}`);
      }
      return response.body;
    },
    async listTools() {
      const reply = await this.rpc({ jsonrpc: "2.0", id: ++id, method: "tools/list" }, "2025-11-25");
      if (!Array.isArray(reply?.result?.tools)) throw new Error("Harnest tool discovery failed");
      return reply.result.tools;
    },
    async call(name, args) {
      const reply = await this.rpc({
        jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args },
      }, "2025-11-25");
      if (reply?.error || reply?.result?.isError) {
        throw new Error(reply.result?.structuredContent?.error?.message ?? reply.error?.message
          ?? reply.result?.content?.find((item) => item.type === "text")?.text ?? "Harnest tool failed");
      }
      return reply?.result?.structuredContent ?? {};
    },
  };
}
