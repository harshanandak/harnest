import { spawnNativeCommand } from "../launch-command.mjs";
import { runProcess } from "../process.mjs";
import { executionError } from "../execution-controls.mjs";

export async function requireExecutionFlags({ launch, request, env, spawnFn, signal }, command, flags, usage) {
  if (!flags.length) return;
  const [firstField] = flags[0];
  let output;
  try {
    output = await runProcess(launch.command, [...(launch.args || []), ...command, "--help"], {
      cwd: request.cwd,
      env,
      spawnFn: spawnFn || spawnNativeCommand,
      signal,
      timeoutMs: Math.min(5_000, request.execution?.timeoutMs ?? 5_000),
      maxStdoutBytes: 128 * 1024,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw executionError(firstField, "could not verify support from the installed CLI help");
  }
  const help = `${output.stdout}\n${output.stderr}`;
  if (usage && !usage.test(help)) throw executionError(firstField, "is unsupported in the installed CLI");
  for (const [field, flag, suffix = "(?:[\\s,=]|$)"] of flags) {
    if (!new RegExp(`^\\s*(?:-[a-zA-Z],\\s*)?${flag}${suffix}`, "m").test(help)) {
      throw executionError(field, `requires ${flag} support in the installed CLI`);
    }
  }
}
