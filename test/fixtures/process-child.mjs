import { once } from "node:events";

async function write(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

const mode = process.argv[2];
if (mode === "volume") {
  const chunk = Buffer.alloc(65536, "x");
  chunk[chunk.length - 1] = 10;
  for (let i = 0; i < 1024; i++) await write(process.stdout, chunk);
  for (let i = 0; i < 8; i++) await write(process.stderr, chunk);
  await write(process.stdout, '{"type":"result","result":"terminal"}\n');
} else if (mode === "unterminated") {
  for (let i = 0; i < 64; i++) await write(process.stdout, Buffer.alloc(65536, "x"));
  setInterval(() => {}, 1000);
} else if (mode === "wait") {
  process.stderr.write("diagnostic tail\n");
  console.log("ready");
  setInterval(() => {}, 1000);
} else if (mode === "read") {
  let bytes = 0;
  for await (const chunk of process.stdin) bytes += chunk.length;
  console.log(bytes);
} else if (mode === "exec-path") {
  console.log(process.execPath);
} else if (mode === "claude-exec-path") {
  console.log(JSON.stringify({ type: "result", subtype: "success", result: process.execPath, session_id: "fixture-session" }));
}
