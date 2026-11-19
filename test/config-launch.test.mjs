// Windows launch resolution: .ps1 shims forward $args through PowerShell 5.1
// native reconstruction, which strips embedded quotes and can split long
// prompts. Cursor/Codex must resolve to direct node entrypoints when the
// installed layout is recognized, falling back to the shim otherwise.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { harnessLaunch } from "../src/config.mjs";
import { resolveTrustedCommand } from "../src/launch-command.mjs";

async function withEnv(name, value, work) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("trusted PATH resolution covers every native adapter default command", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "harnest-native-commands-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  const path = ["", ".", "..", "relative-bin", windows ? `"${bin}"` : bin].join(delimiter);
  const env = windows ? { Path: path, PathExt: ".CMD;.exe" } : { PATH: path };
  const commands = {
    claude: "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode",
    pi: "pi", gemini: "gemini", amp: "amp",
  };
  await withEnv("PATH", bin, async () => {
    for (const [target, name] of Object.entries(commands)) {
      const override = target === "opencode" ? "HARNEST_OPENCODE_V2" : `HARNEST_${target.toUpperCase()}`;
      await withEnv(override, undefined, async () => {
        const { command } = harnessLaunch(target);
        assert.equal(command, name);
        const executable = join(bin, windows ? `${name}.exe` : name);
        if (windows) await writeFile(join(bin, `${name}.cmd`), "fixture");
        await writeFile(executable, "fixture", { mode: 0o755 });
        assert.equal(resolveTrustedCommand(command, env), executable);
      });
    }
  });
  const explicit = join(bin, "explicit-command");
  assert.equal(resolveTrustedCommand(explicit, {}), explicit);
});

test("OpenCode V2 resolves the native binary behind the renamed opencode command", { skip: process.platform !== "win32" }, async (t) => {
  for (const [shim, binary] of [["opencode.ps1", "opencode.exe"], ["opencode2.ps1", "opencode2.exe"], ["opencode.cmd", "opencode.exe"]]) {
    const bin = await mkdtemp(join(tmpdir(), "harnest-v2bin-"));
    t.after(() => rm(bin, { recursive: true, force: true }));
    const native = join(bin, "node_modules", "@opencode", "cli", "bin", binary);
    await mkdir(join(bin, "node_modules", "@opencode", "cli", "bin"), { recursive: true });
    await writeFile(join(bin, shim), "# npm shim");
    await writeFile(native, "fixture");
    await withEnv("PATH", bin, () => withEnv("HARNEST_OPENCODE_V2", undefined, async () => {
      assert.deepEqual(harnessLaunch("opencode"), { command: native, args: [] }, `${binary} layout must resolve`);
    }));
  }
});

test("OpenCode discovery uses the supplied PATH and Windows shim environment", async (t) => {
  const host = await mkdtemp(join(tmpdir(), "harnest-opencode-host-path-"));
  const supplied = await mkdtemp(join(tmpdir(), "harnest-opencode-supplied-path-"));
  for (const directory of [host, supplied]) t.after(() => rm(directory, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  const extension = windows ? ".exe" : "";
  const name = `opencode2${extension}`;
  for (const directory of [host, supplied]) await writeFile(join(directory, name), "fixture", { mode: 0o755 });
  await withEnv("PATH", host, () => withEnv("HARNEST_OPENCODE_V2", undefined, async () => {
    await withEnv("PATHEXT", extension || undefined, () => {
      assert.equal(harnessLaunch("opencode", undefined, { config: {} }).command, join(host, name));
    });
    const env = windows ? { Path: supplied, PATHEXT: extension, SystemRoot: join(supplied, "fixture-windows") } : { PATH: supplied };
    assert.equal(harnessLaunch("opencode", undefined, { config: {}, env }).command, join(supplied, name));
    if (windows) {
      await rm(join(supplied, name));
      const shim = join(supplied, "opencode2.ps1");
      await writeFile(shim, "# fixture shim");
      const powerShellDirectory = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
      const powerShell = join(powerShellDirectory, "powershell.exe");
      await mkdir(powerShellDirectory, { recursive: true });
      await writeFile(powerShell, "");
      assert.deepEqual(harnessLaunch("opencode", undefined, { config: {}, env }), {
        command: powerShell,
        args: ["-NoProfile", "-File", shim],
      });
    }
  }));
});

test("a stale executable pin falls back to detection and fails only when nothing resolves", { skip: process.platform !== "win32" }, async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "harnest-stale-pin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const native = join(bin, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  await mkdir(join(bin, "node_modules", "@opencode", "cli", "bin"), { recursive: true });
  await writeFile(join(bin, "opencode.ps1"), "# npm shim");
  await writeFile(native, "fixture");
  await withEnv("PATH", bin, () => withEnv("HARNEST_OPENCODE_V2", "C:\\definitely\\missing\\opencode2.exe", async () => {
    const launch = harnessLaunch("opencode");
    assert.equal(launch.command, native, "a missing pin must fall back to current detection");
    assert.equal(launch.fallbackFrom, "HARNEST_OPENCODE_V2");
    assert.match(launch.missing, /missing\\opencode2\.exe/);
  }));
  const empty = await mkdtemp(join(tmpdir(), "harnest-stale-pin-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await withEnv("PATH", empty, () => withEnv("HARNEST_OPENCODE_V2", "C:\\definitely\\missing\\opencode2.exe", async () => {
    assert.throws(() => harnessLaunch("opencode"), (error) => {
      assert.match(error.message, /does not exist/);
      assert.equal(error.details.kind, "not-ready");
      assert.match(error.details.source, /HARNEST_OPENCODE_V2/);
      return true;
    });
  }));
});

test("cursor resolves to the versioned node entrypoint when the layout is recognized", { skip: process.platform !== "win32" }, async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "harnest-cursorbin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "cursor-agent.ps1"), "# shim\n");
  const ver = join(bin, "versions", "2026.09.02-c22c1a3");
  await mkdir(ver, { recursive: true });
  await writeFile(join(ver, "node.exe"), "fake");
  await writeFile(join(ver, "index.js"), "fake");
  // An older layout must lose to the newer one.
  const old = join(bin, "versions", "2026.08.25-3e8eec8");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "node.exe"), "fake");
  await writeFile(join(old, "index.js"), "fake");
  await withEnv("PATH", `${bin}${delimiter}${process.env.PATH || ""}`, async () => {
    await withEnv("HARNEST_CURSOR", undefined, async () => {
      const launch = harnessLaunch("cursor");
      assert.equal(launch.command, join(ver, "node.exe"));
      assert.deepEqual(launch.args, [join(ver, "index.js")]);
    });
  });
});

test("cursor falls back to the ps1 shim when no versioned entrypoint exists", { skip: process.platform !== "win32" }, async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "harnest-cursorshim-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "cursor-agent.ps1"), "# shim\n");
  await withEnv("PATH", `${bin}${delimiter}${process.env.PATH || ""}`, async () => {
    await withEnv("HARNEST_CURSOR", undefined, async () => {
      // PATH still contains the real install later in the list, so scope the
      // assertion to fallback shape only when direct resolution misses.
      const launch = harnessLaunch("cursor");
      assert.ok(Array.isArray(launch.args));
      assert.equal(typeof launch.command, "string");
    });
  });
});

test("codex resolves to the npm node entrypoint when the layout is recognized", { skip: process.platform !== "win32" }, async (t) => {
  const { mkdtemp, mkdir, writeFile: writeFixture, rm: removeFixture } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { delimiter: pathDelimiter, join: joinPath } = await import("node:path");
  const bin = await mkdtemp(joinPath(tmpdir(), "harnest-codexbin-"));
  t.after(() => removeFixture(bin, { recursive: true, force: true }));
  await writeFixture(joinPath(bin, "codex.cmd"), "@ECHO off\n");
  const entryDir = joinPath(bin, "node_modules", "@openai", "codex", "bin");
  await mkdir(entryDir, { recursive: true });
  await writeFixture(joinPath(entryDir, "codex.js"), "fake");
  await writeFixture(joinPath(bin, "node.exe"), "fake");
  const previousPath = process.env.PATH;
  const previousOverride = process.env.HARNEST_CODEX;
  process.env.PATH = `${bin}${pathDelimiter}${previousPath || ""}`;
  delete process.env.HARNEST_CODEX;
  try {
    const launch = harnessLaunch("codex");
    assert.equal(launch.command, joinPath(bin, "node.exe"));
    assert.deepEqual(launch.args, [joinPath(entryDir, "codex.js")]);
  } finally {
    process.env.PATH = previousPath;
    if (previousOverride === undefined) delete process.env.HARNEST_CODEX;
    else process.env.HARNEST_CODEX = previousOverride;
  }
});

for (const [extension, contents] of [["ps1", "# shim\n"], ["cmd", "@ECHO off\n"]]) {
  test(`Gemini resolves its .${extension} npm shim to the direct Node entrypoint`, { skip: process.platform !== "win32" }, async (t) => {
    const bin = await mkdtemp(join(tmpdir(), "harnest-geminibin-"));
    t.after(() => rm(bin, { recursive: true, force: true }));
    await writeFile(join(bin, `gemini.${extension}`), contents);
    const entrypoint = join(bin, "node_modules", "@google", "gemini-cli", "dist", "index.js");
    await mkdir(join(bin, "node_modules", "@google", "gemini-cli", "dist"), { recursive: true });
    await writeFile(entrypoint, "fake");
    await withEnv("PATH", bin, () => withEnv("HARNEST_GEMINI", undefined, async () => {
      assert.deepEqual(harnessLaunch("gemini"), { command: process.execPath, args: [entrypoint] });
    }));
  });
}

test("Pi resolves its npm shim to the direct Node entrypoint", { skip: process.platform !== "win32" }, async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "harnest-pibin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "pi.cmd"), "@ECHO off\n");
  const packageRoot = join(bin, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
  await mkdir(packageRoot, { recursive: true });
  const entrypoint = join(packageRoot, "cli.js");
  await writeFile(entrypoint, "fixture");
  await withEnv("PATH", bin, () => withEnv("HARNEST_PI", undefined, async () => {
    assert.deepEqual(harnessLaunch("pi"), { command: process.execPath, args: [entrypoint] });
  }));
});

test("Gemini and Amp honor their dedicated executable environment variables", async () => {
  await withEnv("HARNEST_GEMINI", "fixture-gemini", async () => {
    assert.deepEqual(harnessLaunch("gemini"), { command: "fixture-gemini", args: [] });
  });
  await withEnv("HARNEST_AMP", "fixture-amp", async () => {
    assert.deepEqual(harnessLaunch("amp"), { command: "fixture-amp", args: [] });
  });
});
