import { daemonStatus, ensureDaemon, stopDaemon } from "../src/daemon-client.mjs";

import { applyLoginEnvironment, removeAutostart } from "./install-daemon.mjs";

try {
  switch (process.argv[2]) {
    case "start":
      if (process.argv[3] === "--login-env") applyLoginEnvironment(process.argv[4]);
      console.log(JSON.stringify(await ensureDaemon()));
      break;
    case "status":
      console.log(JSON.stringify(await daemonStatus()));
      break;
    case "stop": {
      const status = await stopDaemon();
      console.log(status);
      if (status === "busy") process.exitCode = 1;
      break;
    }
    case "uninstall-autostart":
      await removeAutostart();
      console.log("Harnest login item removed.");
      break;
    default:
      console.error("Usage: bun run daemon start|stop|status|uninstall-autostart");
      process.exitCode = 1;
  }
} catch {
  console.error(process.argv[2] === "uninstall-autostart"
    ? "Could not remove the Harnest login item. Check your user login registration and permissions."
    : "Harnest daemon command failed. Check the loopback port and daemon directory permissions.");
  process.exitCode = 1;
}
