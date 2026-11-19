import { createInterface } from "node:readline";

const mode = process.argv[2];
if (!mode) process.exit(0);
if (mode === "exit") process.exit(3);
// Keep the RPC process alive after a response and resist graceful shutdown.
// The smoke must terminate it and observe close before reporting readiness.
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "hang") return;
  if (mode === "noise") for (const value of [null, false, 42, "startup", []]) console.log(JSON.stringify(value));
  const commands = mode === "missing" ? [] : [{ name: "review" }];
  console.log(JSON.stringify({ id: message.id, success: mode !== "rejected", data: { commands } }));
});
