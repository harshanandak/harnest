import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DAEMON_HOST, DAEMON_PORT, VERSION, daemonAddress, daemonDirectory, daemonProof, privatePath, readDaemonToken,
} from "./daemon-settings.mjs";
import { hasUserOnlyWindowsAcl, protectWindowsPath } from "./windows-acl.mjs";

async function createToken(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, await lstat(directory), true);
  let existingToken;
  try {
    existingToken = await readDaemonToken(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existingToken) {
    if (process.platform === "win32") {
      const directoryOptions = { directory: true };
      if (!hasUserOnlyWindowsAcl(directory, directoryOptions)) protectWindowsPath(directory, directoryOptions);
      const path = join(directory, "token");
      if (!hasUserOnlyWindowsAcl(path)) protectWindowsPath(path);
    }
    return existingToken;
  }
  if (process.platform === "win32") protectWindowsPath(directory, { directory: true });
  const token = randomBytes(32).toString("hex");
  const temp = join(directory, `token.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, token, { flag: "wx", mode: 0o600 });
    await rename(temp, join(directory, "token"));
  } finally {
    await unlink(temp).catch(() => {});
  }
  return token;
}

export async function startDaemon({
  port = DAEMON_PORT, directory = daemonDirectory(), version = VERSION, buildServices,
} = {}) {
  let dispatch = (_req, res) => { res.writeHead(503); res.end(); };
  const server = createServer((req, res) => dispatch(req, res));
  server.maxHeadersCount = 64;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: DAEMON_HOST, port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") return null;
    throw error;
  }

  port = server.address().port;
  const nonce = randomUUID();
  const record = join(directory, "daemon.json");
  const temp = join(directory, `daemon.${nonce}.tmp`);
  const address = daemonAddress(port);
  let services, mcp;
  let ready = false;
  let closing;
  async function close() {
    ready = false;
    closing ??= (async () => {
      try {
        await mcp?.close();
        await services?.close();
      } finally {
        try {
          const current = JSON.parse(await readFile(record, "utf8"));
          if (current.nonce === nonce) await unlink(record);
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        } finally {
          // Drop kept-alive client sockets too. Otherwise a client polling over
          // keep-alive keeps reaching this stopping daemon and never sees the
          // port released.
          await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          });
        }
      }
    })();
    return closing;
  }
  const stop = () => { close().catch(() => { process.exitCode = 1; }); };
  try {
    const token = await createToken(directory);
    const { createMcpHttpHandler, bearerVerifier, rejectLocalRequest, json } = await import("./mcp-http.mjs");
    const { createServerFactory } = await import("./mcp-server.mjs");
    buildServices ??= (await import("./runtime-services.mjs")).createRuntimeServices;
    services = buildServices();
    mcp = createMcpHttpHandler(createServerFactory(services, { cacheSchemas: true }));
    const authorized = bearerVerifier(token);
    dispatch = (req, res) => {
      if (rejectLocalRequest(req, res, port)) return;
      const challenge = /^\/proof\?challenge=([a-f0-9]{64})$/.exec(req.url)?.[1];
      if (req.method === "GET" && challenge && ready) {
        return json(res, 200, { proof: daemonProof(token, challenge) });
      }
      if (!authorized(req)) return json(res, 401, { error: "Unauthorized" });
      if (req.method === "GET" && req.url === "/health") return json(res, ready ? 200 : 503, { version, ready });
      if (!ready) return json(res, 503, { error: "Daemon is stopping" });
      if (req.method === "POST" && req.url === "/stop") {
        if (req.headers["if-match"] && req.headers["if-match"] !== `"${version}"`) return json(res, 412, { error: "Daemon version changed" });
        if (mcp.isBusy() || services.isBusy()) return json(res, 409, { error: "Daemon is busy" });
        ready = false;
        json(res, 200, { stopping: true });
        stop();
        return;
      }
      if (req.url === "/mcp") return void mcp.handle(req, res, `${address}/mcp`, () => ready);
      return json(res, 404, { error: "Not found" });
    };
    await writeFile(temp, JSON.stringify({ pid: process.pid, port, version, nonce }) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, record);
    ready = true;
    return { port, close };
  } catch (error) {
    await unlink(temp).catch(() => {});
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The private fixture argument lets CI exercise real processes on ephemeral ports.
  const port = process.argv[2] === "--fixture-port" && process.env.HARNEST_STATE_DIR ? Number(process.argv[3]) : DAEMON_PORT;
  try {
    const daemon = await startDaemon({ port });
    if (daemon) {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => { daemon.close().catch(() => { process.exitCode = 1; }); });
      }
    }
  } catch {
    process.stderr.write("Harnest daemon could not start. Check the port and daemon directory permissions.\n");
    process.exitCode = 1;
  }
}
