import { ensureDaemon } from "../src/daemon-client.mjs";
import { readDaemonToken } from "../src/daemon-settings.mjs";

try {
  await ensureDaemon();
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${await readDaemonToken()}` }) + "\n");
} catch {
  process.stderr.write("Harnest could not prepare daemon authentication.\n");
  process.exitCode = 1;
}
