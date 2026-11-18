import { createHash, timingSafeEqual } from "node:crypto";
import {
  createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EXCHANGES = 64;
const hash = (value) => createHash("sha256").update(value).digest();

export function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function rejectLocalRequest(req, res, port) {
  const authority = `127.0.0.1:${port}`;
  const headers = req.headersDistinct;
  if (req.socket.remoteAddress !== "127.0.0.1" || headers.host?.length !== 1 ||
      req.headers.host !== authority || headers["x-forwarded-host"] || headers.forwarded) {
    json(res, 403, { error: "Invalid Host" });
    return true;
  }
  const origins = headers.origin;
  if (origins && (origins.length !== 1 ||
      ![`http://${authority}`, `http://localhost:${port}`].includes(origins[0]))) {
    json(res, 403, { error: "Invalid Origin" });
    return true;
  }
  return false;
}

export function bearerVerifier(token) {
  const expected = hash(`Bearer ${token}`);
  return (req) => req.headersDistinct.authorization?.length === 1 &&
    timingSafeEqual(expected, hash(req.headers.authorization));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off("data", data);
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", data);
    req.once("end", () => {
      if (size <= MAX_BODY_BYTES) resolve(Buffer.concat(chunks, size));
    });
    req.once("error", reject);
  });
}

export function createMcpHttpHandler(factory) {
  const modern = createMcpHandler(factory, { legacy: "reject", responseMode: "json", maxSubscriptions: 0 });
  let active = 0;

  async function handle(req, res, url, accepting) {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const contentType = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return json(res, 415, { error: "Expected application/json" });
    if (+req.headers["content-length"] > MAX_BODY_BYTES) {
      res.setHeader("Connection", "close");
      return json(res, 413, { error: "MCP body exceeds 2 MiB" });
    }
    if (active >= MAX_EXCHANGES) return json(res, 503, { error: "Too many MCP requests" });
    active++;
    try {
      const body = await readBody(req);
      if (body === null) {
        res.setHeader("Connection", "close");
        return json(res, 413, { error: "MCP body exceeds 2 MiB" });
      }
      if (!accepting()) return json(res, 503, { error: "Daemon is stopping" });

      const headers = new Headers();
      for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
        if (req.headers[name]) headers.set(name, req.headers[name]);
      }
      // The accepted exchange has its own lifetime, independent of the socket.
      const request = new Request(url, { method: "POST", headers, body });
      let parsedBody;
      try { parsedBody = JSON.parse(body); } catch { /* SDK formats the parse error. */ }
      let response;
      if (await isLegacyRequest(request, parsedBody)) {
        const server = factory({ era: "legacy" });
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        try {
          await server.connect(transport);
          response = await transport.handleRequest(request, { parsedBody });
        } finally {
          await server.close();
        }
      } else {
        response = await modern.fetch(request, { parsedBody });
      }
      if (res.destroyed) {
        await response.body?.cancel();
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      for await (const chunk of response.body ?? []) {
        if (res.destroyed) break;
        res.write(chunk);
      }
      res.end();
    } catch {
      if (!res.headersSent) json(res, 500, { error: "MCP exchange failed" });
      else res.destroy();
    } finally {
      active--;
    }
  }

  return { handle, isBusy: () => active !== 0, close: () => modern.close() };
}
