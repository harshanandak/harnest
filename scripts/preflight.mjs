import { readFile } from "node:fs/promises";
import { preflight } from "../src/preflight.mjs";
import { runtimeInfo } from "../src/runtime-info.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log("Usage: node scripts/preflight.mjs --request <request.json>\nValidates the request, routing policy and cwd without creating a job or invoking an adapter. The configured trusted routing resolver runs as usual.");
} else if (args.length !== 2 || args[0] !== "--request" || !args[1] || args[1].startsWith("--")) {
  console.error("Usage: node scripts/preflight.mjs --request <request.json>");
  process.exitCode = 1;
} else {
  try {
    let request;
    try { request = JSON.parse(await readFile(args[1], "utf8")); }
    catch { throw new TypeError("request file is unreadable or invalid JSON"); }
    console.log(JSON.stringify({ preflight: await preflight(request), runtime: runtimeInfo() }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: { kind: error?.details?.kind || "validation", message: error.message }, runtime: runtimeInfo() }, null, 2));
    process.exitCode = 1;
  }
}
