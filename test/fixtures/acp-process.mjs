import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

export class FakeAcpProcess extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.received = [];
    this.#onMessage = onMessage;
    this.#input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#input += Buffer.from(chunk).toString("utf8");
        const lines = this.#input.split("\n");
        this.#input = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          this.received.push(message);
          queueMicrotask(() => Promise.resolve(this.#onMessage?.(message, this)).catch((error) => this.emit("error", error)));
        }
        callback();
      },
    });
    this.stdin.once("finish", () => this.kill());
  }

  #input;
  #onMessage;

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(value) {
    this.stdout.write(value);
  }

  respond(request, result) {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  reject(request, code, message, data) {
    this.send({ jsonrpc: "2.0", id: request.id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(id, method, params) {
    this.send({ jsonrpc: "2.0", id, method, params });
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
  }
}

export function createFakeAcpSpawn(onMessage, { autoClose = true } = {}) {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    const child = new FakeAcpProcess((message, process) => {
      if (autoClose && message.method === "session/close") {
        process.respond(message, {});
        return;
      }
      return onMessage?.(message, process);
    });
    calls.push({ command, args, options, child });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}
