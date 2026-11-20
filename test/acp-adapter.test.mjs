import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ACPAdapter, AcpAdapterError } from "../src/adapters/acp.mjs";
import { createFakeAcpSpawn } from "./fixtures/acp-process.mjs";

function request(overrides = {}) {
  const base = {
    requestId: "req-acp-1",
    protocolVersion: "1.0",
    task: "Make the approved change and report the result.",
    contextDigest: "digest-acp-1",
    context: { directDependencies: [{ nodeId: "upstream", finalText: "READY" }] },
    cwd: process.cwd(),
    target: "acp",
    route: { harness: "acp", agent: "fake" },
    policy: { write: true, tools: [], maxCostUsd: null },
    metadata: { harnest: { writeApproved: true } },
    execution: {},
  };
  return {
    ...base,
    ...overrides,
    route: { ...base.route, ...(overrides.route ?? {}) },
    policy: { ...base.policy, ...(overrides.policy ?? {}) },
    metadata: overrides.metadata ?? base.metadata,
    execution: { ...base.execution, ...(overrides.execution ?? {}) },
  };
}

function adapterOptions(fake, overrides = {}) {
  return {
    command: "fake-acp",
    args: ["--stdio"],
    spawn: fake.spawn,
    timeoutMs: 500,
    startupTimeoutMs: 200,
    cancelTimeoutMs: 100,
    clientServicesFactory: () => ({
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      async handleRequest() { throw Object.assign(new Error("unsupported test callback"), { rpcCode: -32601 }); },
      async close() {},
    }),
    ...overrides,
  };
}

function initializeResult(version, capabilities = {}) {
  return version === 2
    ? {
      protocolVersion: 2,
      capabilities,
      info: { name: "fake-acp", title: "Fake ACP", version: "0.0-test" },
    }
    : {
      protocolVersion: 1,
      agentCapabilities: capabilities,
      agentInfo: { name: "fake-acp", title: "Fake ACP", version: "0.0-test" },
    };
}

function startV2Foreground(child, sessionId, messageId) {
  child.notify("session/update", {
    sessionId,
    update: { sessionUpdate: "user_message", messageId, content: [] },
  });
  child.notify("session/update", {
    sessionId,
    update: { sessionUpdate: "state_update", state: "running" },
  });
}

test("ACP v1 embeds both advertised attachment types in the native prompt", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-acp-controls-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const image = join(cwd, "input.png");
  const file = join(cwd, "input.txt");
  await Promise.all([writeFile(image, "image bytes"), writeFile(file, "file bytes")]);
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      child.respond(message, initializeResult(1, { promptCapabilities: { image: true, embeddedContext: true } }));
    } else if (message.method === "session/new") {
      child.respond(message, { sessionId: "acp-session" });
    } else if (message.method === "session/prompt") {
      child.notify("session/update", {
        sessionId: "acp-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "received" } },
      });
      child.respond(message, { stopReason: "end_turn" });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 }));
  const output = await adapter.run(request({
    cwd, execution: { attachments: [{ type: "image", path: image }, { type: "file", path: file }] },
  }));
  assert.equal(output.result.finalText, "received");
  const prompt = fake.children[0].received.find((item) => item.method === "session/prompt").params.prompt;
  assert.equal(prompt[0].type, "text");
  assert.deepEqual(prompt.slice(1), [
    { type: "image", mimeType: "image/png", data: Buffer.from("image bytes").toString("base64") },
    { type: "resource", resource: { uri: pathToFileURL(await realpath(file)).href, blob: Buffer.from("file bytes").toString("base64") } },
  ]);
});

test("ACP v2 rejects attachment types its agent did not advertise before creating a session", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-acp-capabilities-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "input.txt");
  await writeFile(path, "file bytes");
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: { prompt: { image: {} } } }));
  });
  const adapter = new ACPAdapter(adapterOptions(fake));
  await assert.rejects(adapter.run(request({ cwd, execution: { attachments: [{ type: "file", path }] } })), /did not advertise embeddedContext/);
  assert.deepEqual(fake.children[0].received.map(({ method }) => method), ["initialize"]);
});

test("ACP v2 waits for idle completion, streams with backpressure, and returns native identity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstProgress = Promise.withResolvers();
  const releaseProgress = Promise.withResolvers();
  const usageDelivered = Promise.withResolvers();
  const releaseIdle = Promise.withResolvers();
  const progressOrder = [];
  const progressTypes = [];
  const progressEvents = [];
  let progressReleased = false;
  const fake = createFakeAcpSpawn(async (message, child) => {
    if (message.method === "initialize") {
      assert.equal(message.params.protocolVersion, 2);
      assert.deepEqual(message.params.capabilities, {});
      assert.deepEqual(message.params.info, { name: "harnest", title: "Harnest", version: "0.1.0" });
      child.respond(message, initializeResult(2, { session: {} }));
    } else if (message.method === "session/new") {
      child.respond(message, { sessionId: "session-v2" });
    } else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "user-message-1" });
      startV2Foreground(child, "session-v2", "user-message-1");
      child.notify("session/update", {
        sessionId: "session-v2",
        update: { sessionUpdate: "agent_message_chunk", messageId: "answer-1", content: { type: "text", text: "first " } },
      });
      child.notify("session/update", {
        sessionId: "session-v2",
        update: { sessionUpdate: "agent_message_chunk", messageId: "answer-1", content: { type: "text", text: "second" } },
      });
      child.notify("session/update", {
        sessionId: "session-v2",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", name: "run_tests", status: "in_progress", rawInput: { token: "must-not-leak" } },
      });
      child.notify("session/update", {
        sessionId: "session-v2",
        update: { sessionUpdate: "usage_update", used: 42, size: 128, cost: { amount: 1.25, currency: "EUR" } },
      });
      await releaseIdle.promise;
      child.notify("session/update", {
        sessionId: "session-v2",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake));
  const run = adapter.run(request(), {
    onProgress: async (event) => {
      progressEvents.push(event);
      progressTypes.push(event.type);
      progressOrder.push(event.text ?? event.type);
      if (event.text === "first ") {
        firstProgress.resolve();
        await releaseProgress.promise;
      }
      if (event.text === "second") progressReleased = true;
      if (event.type === "usage") usageDelivered.resolve();
    },
  });
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([firstProgress.promise, run]);
    t.mock.timers.tick(499);
    assert.deepEqual(progressOrder, ["first "]);
    assert.equal(settled, false);
    releaseProgress.resolve();
    await Promise.race([usageDelivered.promise, run]);
    assert.equal(settled, false);
  } finally {
    releaseProgress.resolve();
    releaseIdle.resolve();
  }
  const output = await run;

  assert.equal(progressReleased, true);
  assert.deepEqual(progressOrder.slice(0, 2), ["first ", "second"]);
  assert.deepEqual(progressTypes, ["acp_delta", "acp_delta", "acp_tool", "usage"]);
  const toolProgress = progressEvents.find((event) => event.type === "acp_tool");
  assert.deepEqual(
    { toolName: toolProgress.toolName, status: toolProgress.status, phase: toolProgress.phase },
    { toolName: "run_tests", status: "in_progress", phase: "in_progress" },
  );
  assert.doesNotMatch(JSON.stringify(toolProgress), /must-not-leak/);
  assert.equal(output.sessionId, "session-v2");
  assert.equal(output.workflowRunId, "acp:req-acp-1");
  assert.equal(output.route.harness, "acp");
  assert.equal(output.route.agent, "fake");
  assert.equal(output.route.protocolVersion, 2);
  assert.equal(output.result.finalText, "first second");
  assert.equal(output.usage.contextWindowUsed, 42);
  assert.equal(output.usage.cost.currency, "EUR");
  assert.equal(output.usageSummary.costUsd, null);
  assert.equal(output.usageSummary.inputTokens, null);
  assert.equal(fake.calls[0].options.shell, false);
  assert.deepEqual(fake.calls[0].args, ["--stdio"]);
});

test("ACP v2 prompt acceptance without idle completion times out", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "session-never-idle" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "accepted-only" });
      startV2Foreground(child, "session-never-idle", "accepted-only");
    } else if (message.method === "session/cancel") {
      child.notify("session/update", { sessionId: "session-never-idle", update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" } });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake, { timeoutMs: 40 }));
  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "timeout");
    assert.equal(error.details?.sessionId, "session-never-idle");
    return true;
  });
  assert.equal(fake.children[0].killed, true);
});

test("ACP v2 ignores background output and idle until the submitted prompt foreground epoch", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "interleaved-session" });
    else if (message.method === "session/prompt") {
      child.notify("session/update", {
        sessionId: "interleaved-session",
        update: { sessionUpdate: "agent_message", messageId: "background-answer", content: [{ type: "text", text: "BACKGROUND RESULT" }] },
      });
      child.notify("session/update", {
        sessionId: "interleaved-session",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
      child.respond(message, { messageId: "submitted-user" });
      child.notify("session/update", {
        sessionId: "interleaved-session",
        update: { sessionUpdate: "user_message", messageId: "submitted-user", content: [{ type: "text", text: "submitted" }] },
      });
      child.notify("session/update", {
        sessionId: "interleaved-session",
        update: { sessionUpdate: "state_update", state: "running" },
      });
      child.notify("session/update", {
        sessionId: "interleaved-session",
        update: { sessionUpdate: "agent_message", messageId: "foreground-answer", content: [{ type: "text", text: "FOREGROUND RESULT" }] },
      });
      child.notify("session/update", {
        sessionId: "interleaved-session",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.result.finalText, "FOREGROUND RESULT");
});

test("ACP v2 preserves a matching foreground epoch that completes before the prompt response", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "response-race-session" });
    else if (message.method === "session/prompt") {
      child.notify("session/update", {
        sessionId: "response-race-session",
        update: { sessionUpdate: "user_message", messageId: "race-user", content: [{ type: "text", text: "submitted" }] },
      });
      child.notify("session/update", {
        sessionId: "response-race-session",
        update: { sessionUpdate: "state_update", state: "running" },
      });
      child.notify("session/update", {
        sessionId: "response-race-session",
        update: { sessionUpdate: "agent_message_chunk", messageId: "race-answer", content: { type: "text", text: "buffered answer" } },
      });
      child.notify("session/update", {
        sessionId: "response-race-session",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
      child.respond(message, { messageId: "race-user" });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.result.finalText, "buffered answer");
});

test("ACP v2 rejects a user_message acknowledgement that disagrees with the prompt response", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "mismatched-ack" });
    else if (message.method === "session/prompt") {
      child.notify("session/update", { sessionId: "mismatched-ack", update: { sessionUpdate: "user_message", messageId: "different-user", content: [] } });
      child.respond(message, { messageId: "submitted-user" });
    }
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "protocol");
    assert.match(error.message, /messageId.*disagrees/);
    return true;
  });
});

test("ACP v2 does not complete from answer and idle without matched user_message and running", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "missing-foreground" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "missing-user-ack" });
      child.notify("session/update", { sessionId: "missing-foreground", update: { sessionUpdate: "agent_message", messageId: "unbound-answer", content: [{ type: "text", text: "must ignore" }] } });
      child.notify("session/update", { sessionId: "missing-foreground", update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
    }
  });
  await assert.rejects(
    new ACPAdapter(adapterOptions(fake, { timeoutMs: 30, cancelTimeoutMs: 30 })).run(request()),
    (error) => error.details?.kind === "cancel-unacknowledged" && error.details?.uncertain === true,
  );
});

test("ACP v2 resume ignores replayed stale agent output and uses only the new turn", async () => {
  const progress = [];
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/resume") {
      child.notify("session/update", {
        sessionId: "native-old",
        update: { sessionUpdate: "agent_message", messageId: "old-answer", content: [{ type: "text", text: "STALE RESULT" }] },
      });
      child.respond(message, {});
    } else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "new-user" });
      startV2Foreground(child, "native-old", "new-user");
      child.notify("session/update", {
        sessionId: "native-old",
        update: { sessionUpdate: "agent_message", messageId: "new-answer", content: [{ type: "text", text: "FRESH RESULT" }] },
      });
      child.notify("session/update", {
        sessionId: "native-old",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake));
  const output = await adapter.run(request({ execution: { sessionId: "native-old" } }), {
    onProgress(event) { progress.push(event); },
  });
  assert.equal(output.sessionId, "native-old");
  assert.equal(output.result.finalText, "FRESH RESULT");
  assert.doesNotMatch(JSON.stringify(progress), /STALE RESULT/);
  assert.equal(fake.children[0].received.some((item) => item.method === "session/new"), false);
});

test("ACP v1 pin advertises implemented client services and uses session/load for resume", async () => {
  let servicesClosed = 0;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      assert.equal(message.params.protocolVersion, 1);
      assert.deepEqual(message.params.clientCapabilities, {
        fs: { readTextFile: true, writeTextFile: true }, terminal: true,
      });
      child.respond(message, initializeResult(1, { loadSession: true }));
    } else if (message.method === "session/load") {
      child.notify("session/update", {
        sessionId: "legacy-native",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE LOAD REPLAY" } },
      });
      child.respond(message, {});
    } else if (message.method === "session/prompt") {
      child.notify("session/update", {
        sessionId: "legacy-native",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "legacy result" } },
      });
      child.respond(message, { stopReason: "end_turn" });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake, {
    protocolVersion: 1,
    clientServicesFactory: () => ({
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      async handleRequest() { return {}; },
      async close() { servicesClosed += 1; },
    }),
  }));
  const output = await adapter.run(request({ execution: { sessionId: "legacy-native" } }));
  assert.equal(output.result.finalText, "legacy result");
  assert.equal(output.route.protocolVersion, 1);
  assert.equal(servicesClosed, 1);
  const init = fake.children[0].received.find((item) => item.method === "initialize");
  assert.deepEqual(init.params.clientCapabilities, {
    fs: { readTextFile: true, writeTextFile: true }, terminal: true,
  });
  const load = fake.children[0].received.find((item) => item.method === "session/load");
  assert.equal(load.params.sessionId, "legacy-native");
});

test("ACP v1 registration pin advertises client services on its single initialization", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      assert.equal(message.params.protocolVersion, 1);
      assert.deepEqual(message.params.clientCapabilities, {
        fs: { readTextFile: true, writeTextFile: true }, terminal: true,
      });
      child.respond(message, initializeResult(1));
    } else if (message.method === "session/new") child.respond(message, { sessionId: "legacy-new" });
    else if (message.method === "session/prompt") {
      child.notify("session/update", { sessionId: "legacy-new", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
      child.respond(message, { stopReason: "end_turn" });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request());
  assert.equal(output.result.finalText, "ok");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.children[0].received.filter((item) => item.method === "initialize").length, 1);
});

test("ACP v1 resolves Windows terminal commands before calling the adapter's launcher", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-terminal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const bin = join(directory, "bin");
  await mkdir(cwd);
  await mkdir(bin);
  const command = "acp-terminal-fixture";
  const expected = join(bin, `${command}.exe`);
  await writeFile(expected, "");
  await writeFile(join(cwd, `${command}.exe`), "");

  const sessionId = "legacy-terminal";
  let terminalResponse;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(1));
    else if (message.method === "session/new") child.respond(message, { sessionId });
    else if (message.method === "session/prompt") {
      child.request("create-terminal", "terminal/create", { sessionId, command });
    } else if (message.id === "create-terminal") {
      terminalResponse = message;
      child.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
      child.respond(child.received.find((item) => item.method === "session/prompt"), { stopReason: "end_turn" });
    }
  });

  const previousPath = process.env.PATH;
  process.env.PATH = `;${bin};`;
  try {
    const adapter = new ACPAdapter({
      registrations: { fake: { command: process.execPath, trusted: true, protocolVersion: 1 } },
      spawn: fake.spawn,
      timeoutMs: 5_000,
    });
    await adapter.run(request({ cwd }));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  assert.match(terminalResponse?.result?.terminalId, /^terminal-/);
  assert.deepEqual(fake.calls.map((call) => call.command), [process.execPath, expected]);
  assert.equal(fake.calls[1].options.shell, false);
});

test("an unpinned v2 negotiation may follow v1 on the same process without claiming v1 callbacks", async () => {
  const callbackResponses = [];
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      assert.equal(message.params.protocolVersion, 2);
      assert.equal(message.params.clientCapabilities, undefined);
      child.respond(message, initializeResult(1));
    } else if (message.method === "session/new") child.respond(message, { sessionId: "fallback-v1" });
    else if (message.method === "session/prompt") {
      child.request("unadvertised", "fs/read_text_file", { sessionId: "fallback-v1", path: "README.md" });
    } else if (message.id === "unadvertised") {
      callbackResponses.push(message.error);
      child.notify("session/update", { sessionId: "fallback-v1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fallback result" } } });
      const prompt = child.received.find((item) => item.method === "session/prompt");
      child.respond(prompt, { stopReason: "end_turn" });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.result.finalText, "fallback result");
  assert.equal(output.route.protocolVersion, 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(callbackResponses[0].code, -32601);
  assert.match(callbackResponses[0].message, /protocolVersion: 1/);
});

test("ACP detects a v1 generation response carried on wire protocolVersion 2", async () => {
  for (const pinned of [false, true]) {
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") {
        assert.equal(message.params.protocolVersion, pinned ? 1 : 2);
        child.respond(message, {
          protocolVersion: 2,
          agentCapabilities: {},
          agentInfo: { name: "compat-v1", version: "1.0" },
        });
      } else if (message.method === "session/new") child.respond(message, { sessionId: `compat-${pinned}` });
      else if (message.method === "session/prompt") {
        child.notify("session/update", { sessionId: `compat-${pinned}`, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "compat result" } } });
        child.respond(message, { stopReason: "end_turn" });
      }
    });
    const output = await new ACPAdapter(adapterOptions(fake, pinned ? { protocolVersion: 1 } : {})).run(request());
    assert.equal(output.result.finalText, "compat result");
    assert.equal(output.route.protocolVersion, 1);
    assert.equal(output.route.wireProtocolVersion, 2);
    assert.equal(fake.calls.length, 1);
  }
});

test("ACP accepts the minimal v1 initialize response with default capabilities", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, { protocolVersion: 1 });
    else if (message.method === "session/new") child.respond(message, { sessionId: "minimal-v1" });
    else if (message.method === "session/prompt") {
      child.notify("session/update", { sessionId: "minimal-v1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "minimal works" } } });
      child.respond(message, { stopReason: "end_turn" });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request());
  assert.equal(output.result.finalText, "minimal works");
  assert.equal(output.route.protocolVersion, 1);
  assert.equal(output.route.wireProtocolVersion, 1);
});

test("ACP rejects mixed generation initialize responses before session dispatch", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      child.respond(message, {
        ...initializeResult(2, { session: {} }),
        agentCapabilities: {},
      });
    }
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "protocol");
    assert.match(error.message, /mixed v1 and v2/);
    return true;
  });
  assert.equal(fake.children[0].received.some((message) => message.method === "session/new"), false);
});

test("resume fails closed when the negotiated version lacks native resume", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(1, { loadSession: false }));
  });
  await assert.rejects(
    new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request({ execution: { sessionId: "cannot-resume" } })),
    (error) => error.details?.kind === "unsupported" && /resume/i.test(error.message),
  );
  assert.equal(fake.children[0].received.some((item) => item.method === "session/new"), false);
});

test("unknown and coercible protocol versions fail before a session or prompt", async () => {
  for (const protocolVersion of [3, "2", true, [2]]) {
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") child.respond(message, { protocolVersion });
    });
    await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
      assert.equal(error.details?.kind, "protocol");
      assert.deepEqual(error.details?.protocolVersion, Array.isArray(protocolVersion) ? null : protocolVersion);
      return true;
    });
    assert.equal(fake.children[0].received.some((item) => item.method === "session/new"), false);
  }
});

test("ACP v2 fails before session/new when the agent omits the session capability", async () => {
  for (const initializeResponse of [
    initializeResult(2, {}),
    initializeResult(2, { session: null }),
    { protocolVersion: 2, info: { name: "fake-acp", version: "0.0-test" } },
  ]) {
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") child.respond(message, initializeResponse);
    });
    await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
      assert.equal(error.details?.kind, "unsupported");
      assert.equal(error.details?.capability, "session");
      return true;
    });
    assert.equal(fake.children[0].received.some((item) => ["session/new", "session/prompt"].includes(item.method)), false);
  }
});

test("ACP v2 rejects missing implementation info before starting a session", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      child.respond(message, { protocolVersion: 2, capabilities: { session: {} }, info: null });
    }
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "protocol");
    assert.equal(error.details?.field, "info");
    return true;
  });
  assert.equal(fake.children[0].received.some((item) => item.method === "session/new"), false);
});

test("ACP v2 rejects agent message updates without a messageId", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "malformed-message-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "valid-user-message" });
      startV2Foreground(child, "malformed-message-session", "valid-user-message");
      child.notify("session/update", {
        sessionId: "malformed-message-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "must not become final" } },
      });
    }
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "protocol");
    assert.match(error.message, /messageId/);
    return true;
  });
});

test("unsupported fields and absent write approval reject before spawn", async () => {
  const cases = [
    request({ policy: { write: false } }),
    request({ metadata: {} }),
    request({ route: { model: "" } }),
    request({ route: { provider: "provider" } }),
    request({ route: { variant: true } }),
    request({ route: { thinking: "high" } }),
    request({ route: { harnessVersion: "v2" } }),
    request({ route: { serverUrl: "http://127.0.0.1:9999" } }),
    request({ route: { customExecutable: "bad" } }),
    request({ policy: { tools: ["shell"] } }),
    request({ policy: { write: true, tools: { deny: ["shell"] } } }),
    request({ policy: { maxCostUsd: 1 } }),
    request({ workflow: { nodes: [{ id: "x" }] } }),
    request({ execution: { transport: "session" } }),
  ];
  for (const candidate of cases) {
    const fake = createFakeAcpSpawn(() => {});
    await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(candidate), (error) => error.details?.kind === "policy");
    assert.equal(fake.calls.length, 0);
  }
});

function routeFixture(session, { resume = false, confirm = true, reject = false } = {}) {
  const sessionId = "route-session";
  let configOptions = session.configOptions;
  return createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      child.respond(message, initializeResult(1, { loadSession: resume }));
    } else if (message.method === (resume ? "session/load" : "session/new")) {
      child.respond(message, { sessionId, ...session });
    } else if (message.method === "session/set_config_option") {
      if (reject) {
        child.reject(message, -32601, "method not found");
        return;
      }
      const { configId, value } = message.params;
      if (confirm) configOptions = configOptions.map((option) => option.id === configId ? { ...option, currentValue: value } : option);
      child.respond(message, { configOptions });
    } else if (message.method === "session/set_model" || message.method === "session/set_mode") {
      child.respond(message, {});
    } else if (message.method === "session/prompt") {
      child.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "routed answer" } },
      });
      child.respond(message, { stopReason: "end_turn" });
    }
  });
}

const advertisedRouteOptions = [
  { id: "engine", category: "model", type: "select", currentValue: "daily", options: [{ group: "pro", options: [{ value: "expert" }] }] },
  { id: "mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "code" }] },
  { id: "depth", type: "select", currentValue: "quick", options: [{ value: "deep" }] },
  { id: "review", type: "boolean", currentValue: true },
];

test("ACP applies exact advertised model, mode and option choices before prompting", async () => {
  const fake = routeFixture({
    configOptions: advertisedRouteOptions,
    modes: { availableModes: [{ id: "code" }] },
  });
  const route = { model: "expert", variant: "code", options: { depth: "deep", review: false } };
  const result = await new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request({ route }));
  assert.equal(result.result.finalText, "routed answer");
  assert.equal(result.route.model, route.model);
  assert.equal(result.route.variant, route.variant);
  assert.deepEqual(result.route.options, route.options);
  const messages = fake.children[0].received.filter(({ method }) => method?.startsWith("session/"));
  assert.deepEqual(messages.map(({ method }) => method),
    ["session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/prompt"]);
  assert.deepEqual(messages.slice(1, 5).map(({ params }) => params), [
    { sessionId: "route-session", configId: "engine", value: "expert" },
    { sessionId: "route-session", configId: "mode", value: "code" },
    { sessionId: "route-session", configId: "depth", value: "deep" },
    { sessionId: "route-session", configId: "review", type: "boolean", value: false },
  ]);
});

test("ACP honors advertised legacy model and mode IDs on session load", async () => {
  const fake = routeFixture({
    models: { currentModelId: "daily", availableModels: [{ modelId: "expert" }] },
    modes: { currentModeId: "ask", availableModes: [{ id: "code" }] },
  }, { resume: true });
  await new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request({
    route: { model: "expert", variant: "code" }, execution: { sessionId: "route-session" },
  }));
  const messages = fake.children[0].received.filter(({ method }) => method?.startsWith("session/"));
  assert.deepEqual(messages.map(({ method }) => method), ["session/load", "session/set_model", "session/set_mode", "session/prompt"]);
  assert.deepEqual(messages[1].params, { sessionId: "route-session", modelId: "expert" });
  assert.deepEqual(messages[2].params, { sessionId: "route-session", modeId: "code" });
});

test("ACP rejects unadvertised or unconfirmed choices before sending a prompt", async () => {
  const cases = [
    [{ model: "explicit-model" }, {}, /route\.model.*not an advertised/],
    [{ variant: "high" }, {}, /route\.variant.*not an advertised/],
    [{ options: { unknown: true } }, {}, /route\.options.*not an advertised/],
    [{ options: { depth: "unknown" } }, {}, /route\.options.*not an advertised/],
    [{ options: { review: "false" } }, {}, /route\.options.*not an advertised/],
    [{ model: "expert", options: { engine: "daily" } }, {}, /route\.options.*duplicates/],
    [{ model: "expert" }, { confirm: false }, /route\.model.*not confirmed/],
    [{ model: "expert" }, { reject: true }, /route\.model.*rejected by session\/set_config_option/],
  ];
  for (const [route, fixture, expected] of cases) {
    const fake = routeFixture({ configOptions: advertisedRouteOptions }, fixture);
    await assert.rejects(new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request({ route })), (error) => {
      assert.equal(error.details.kind, "policy");
      assert.match(error.message, expected);
      return true;
    });
    assert.equal(fake.children[0].received.some(({ method }) => method === "session/prompt"), false);
  }
});

test("missing and untrusted registrations reject before spawn", async () => {
  let spawned = 0;
  const spawn = () => { spawned += 1; throw new Error("must not spawn"); };
  await assert.rejects(
    new ACPAdapter({ registrations: {}, spawn }).run(request()),
    (error) => error.details?.kind === "configuration",
  );
  await assert.rejects(
    new ACPAdapter({ registrations: { fake: { command: "fake-acp", args: [], trusted: false } }, spawn }).run(request()),
    (error) => error.details?.kind === "configuration",
  );
  assert.equal(spawned, 0);
});

test("a trusted ACP registration still needs an absolute executable path", async () => {
  let spawnCount = 0;
  const adapter = new ACPAdapter({
    registrations: { fake: { command: "fake-acp", args: [], trusted: true } },
    spawn() { spawnCount += 1; throw new Error("unexpected spawn"); },
  });

  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "configuration");
    assert.match(error.message, /acp add .*--trust/);
    return true;
  });
  assert.equal(spawnCount, 0);
});

test("permission callbacks choose allow_once only for understood coding operations", async () => {
  const responses = new Map();
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "permission-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "permission-prompt" });
      startV2Foreground(child, "permission-session", "permission-prompt");
      child.request("known", "session/request_permission", {
        sessionId: "permission-session", title: "Run tests", subject: { type: "command", command: "npm test", cwd: process.cwd() },
        options: [
          { optionId: "forever", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
          { optionId: "deny", name: "No", kind: "reject_once" },
        ],
      });
      child.request("unknown", "session/request_permission", {
        sessionId: "permission-session", title: "Mystery",
        subject: { type: "tool_call", toolCall: { toolCallId: "mystery", kind: "other" } },
        options: [
          { optionId: "once2", name: "Once", kind: "allow_once" },
          { optionId: "deny2", name: "No", kind: "reject_once" },
        ],
      });
      child.request("disguised", "session/request_permission", {
        sessionId: "permission-session", title: "Future operation",
        subject: { type: "future_operation" },
        toolCall: { toolCallId: "legacy-looking", kind: "execute" },
        options: [
          { optionId: "once3", name: "Once", kind: "allow_once" },
          { optionId: "deny3", name: "No", kind: "reject_once" },
        ],
      });
      child.request("missing-id", "session/request_permission", {
        sessionId: "permission-session", title: "Malformed tool call",
        subject: { type: "tool_call", toolCall: { kind: "execute" } },
        options: [
          { optionId: "once4", name: "Once", kind: "allow_once" },
          { optionId: "deny4", name: "No", kind: "reject_once" },
        ],
      });
    } else if (["known", "unknown", "disguised", "missing-id"].includes(message.id)) {
      responses.set(message.id, message.result);
      if (responses.size === 4) {
        child.notify("session/update", { sessionId: "permission-session", update: { sessionUpdate: "agent_message", messageId: "answer", content: [{ type: "text", text: "permissions handled" }] } });
        child.notify("session/update", { sessionId: "permission-session", update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
      }
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.result.finalText, "permissions handled");
  assert.deepEqual(responses.get("known"), { outcome: { outcome: "selected", optionId: "once" } });
  assert.deepEqual(responses.get("unknown"), { outcome: { outcome: "selected", optionId: "deny2" } });
  assert.deepEqual(responses.get("disguised"), { outcome: { outcome: "selected", optionId: "deny3" } });
  assert.deepEqual(responses.get("missing-id"), { outcome: { outcome: "selected", optionId: "deny4" } });
});

test("ACP v1 permission callbacks reject tool operations without a toolCallId", async () => {
  let permissionResponse;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(1));
    else if (message.method === "session/new") child.respond(message, { sessionId: "legacy-permission" });
    else if (message.method === "session/prompt") {
      child.request("legacy-missing-id", "session/request_permission", {
        sessionId: "legacy-permission",
        toolCall: { kind: "execute" },
        options: [
          { optionId: "legacy-once", name: "Once", kind: "allow_once" },
          { optionId: "legacy-deny", name: "No", kind: "reject_once" },
        ],
      });
    } else if (message.id === "legacy-missing-id") {
      permissionResponse = message.result;
      child.notify("session/update", { sessionId: "legacy-permission", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "legacy denied" } } });
      const prompt = child.received.find((item) => item.method === "session/prompt");
      child.respond(prompt, { stopReason: "end_turn" });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request());
  assert.equal(output.result.finalText, "legacy denied");
  assert.deepEqual(permissionResponse, { outcome: { outcome: "selected", optionId: "legacy-deny" } });
});

test("ACP responds to a request whose JSON-RPC id is null", async () => {
  let permissionResponse;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "null-id-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "null-id-prompt" });
      startV2Foreground(child, "null-id-session", "null-id-prompt");
      child.request(null, "session/request_permission", {
        sessionId: "null-id-session",
        title: "Run tests",
        subject: { type: "command", command: "npm test", cwd: process.cwd() },
        options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
      });
    } else if (message.id === null && message.result) {
      permissionResponse = message.result;
      child.notify("session/update", { sessionId: "null-id-session", update: { sessionUpdate: "agent_message", messageId: "answer", content: [{ type: "text", text: "null answered" }] } });
      child.notify("session/update", { sessionId: "null-id-session", update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.result.finalText, "null answered");
  assert.deepEqual(permissionResponse, { outcome: { outcome: "selected", optionId: "once" } });
});

test("ACP rejects object and fractional JSON-RPC request ids before answering", async () => {
  for (const badId of [{}, 1.5]) {
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
      else if (message.method === "session/new") child.respond(message, { sessionId: "bad-id-session" });
      else if (message.method === "session/prompt") {
        child.respond(message, { messageId: "bad-id-prompt" });
        child.request(badId, "session/request_permission", {
          sessionId: "bad-id-session",
          title: "Run tests",
          subject: { type: "command", command: "npm test", cwd: process.cwd() },
          options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
        });
      }
    });
    await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
      assert.equal(error.details?.kind, "transport");
      assert.match(error.message, /invalid id/);
      return true;
    });
    assert.equal(fake.children[0].received.some((message) => message.result?.outcome), false);
  }
});

test("ACP redacts recognized credentials before progress and receipt boundaries", async () => {
  const progress = [];
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") {
      child.respond(message, {
        protocolVersion: 2,
        capabilities: { session: {} },
        info: { name: "fake", version: "token=agent-secret-value" },
      });
    } else if (message.method === "session/new") child.respond(message, { sessionId: "redaction-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "redaction-prompt" });
      startV2Foreground(child, "redaction-session", "redaction-prompt");
      child.notify("session/update", {
        sessionId: "redaction-session",
        update: { sessionUpdate: "agent_message", messageId: "redacted-answer", content: [{ type: "text", text: "API_KEY=progress-secret-value done" }] },
      });
      child.notify("session/update", {
        sessionId: "redaction-session",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request(), {
    onProgress(event) { progress.push(event); },
  });
  assert.match(output.result.finalText, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(output), /progress-secret-value|agent-secret-value/);
  assert.doesNotMatch(JSON.stringify(progress), /progress-secret-value/);
});

test("v1 client callbacks are session-scoped and unknown facilities fail closed", async () => {
  const callbackResponses = new Map();
  let serviceCalls = 0;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize" && message.params.protocolVersion === 2) child.respond(message, initializeResult(1));
    else if (message.method === "initialize") child.respond(message, initializeResult(1));
    else if (message.method === "session/new") child.respond(message, { sessionId: "callback-session" });
    else if (message.method === "session/prompt") {
      child.request("foreign", "fs/read_text_file", { sessionId: "other-session", path: "README.md" });
      child.request("unsupported", "custom/danger", { sessionId: "callback-session" });
    } else if (message.id === "foreign" || message.id === "unsupported") {
      callbackResponses.set(message.id, message.error);
      if (callbackResponses.size === 2) {
        child.notify("session/update", { sessionId: "callback-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "callback safe" } } });
        const prompt = child.received.find((item) => item.method === "session/prompt");
        child.respond(prompt, { stopReason: "end_turn" });
      }
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake, {
    protocolVersion: 1,
    clientServicesFactory: () => ({
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      async handleRequest() { serviceCalls += 1; return { content: "secret" }; },
      async close() {},
    }),
  }));
  const output = await adapter.run(request());
  assert.equal(output.result.finalText, "callback safe");
  assert.equal(serviceCalls, 0);
  assert.equal(callbackResponses.get("foreign").code, -32602);
  assert.equal(callbackResponses.get("unsupported").code, -32601);
});

test("abort sends native session/cancel and cleans up the owned process", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "cancel-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "cancel-prompt" });
      child.notify("session/update", { sessionId: "cancel-session", update: { sessionUpdate: "user_message", messageId: "cancel-prompt", content: [] } });
      child.notify("session/update", { sessionId: "cancel-session", update: { sessionUpdate: "state_update", state: "running" } });
      queueMicrotask(() => controller.abort());
    } else if (message.method === "session/cancel") {
      cancelled = true;
      child.notify("session/update", { sessionId: "cancel-session", update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" } });
    }
  });
  await assert.rejects(
    new ACPAdapter(adapterOptions(fake)).run(request(), { signal: controller.signal }),
    (error) => error.details?.kind === "abort" && error.details?.sessionId === "cancel-session",
  );
  assert.equal(cancelled, true);
  assert.equal(fake.children[0].killed, true);
});

test("ACP v2 cancellation accepts correlated cancelled idle before or after the cancel write", async () => {
  for (const acknowledgementTiming of ["before", "after"]) {
    const controller = new AbortController();
    let cancelSeen = false;
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
      else if (message.method === "session/new") child.respond(message, { sessionId: `cancel-${acknowledgementTiming}` });
      else if (message.method === "session/prompt") {
        child.respond(message, { messageId: `cancel-user-${acknowledgementTiming}` });
        child.notify("session/update", { sessionId: `cancel-${acknowledgementTiming}`, update: { sessionUpdate: "user_message", messageId: `cancel-user-${acknowledgementTiming}`, content: [] } });
        child.notify("session/update", { sessionId: `cancel-${acknowledgementTiming}`, update: { sessionUpdate: "state_update", state: "running" } });
        queueMicrotask(() => {
          controller.abort();
          if (acknowledgementTiming === "before") {
            child.notify("session/update", { sessionId: "cancel-before", update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" } });
          }
        });
      } else if (message.method === "session/cancel") {
        cancelSeen = true;
        if (acknowledgementTiming === "after") {
          child.notify("session/update", { sessionId: "cancel-after", update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" } });
        }
      }
    });
    await assert.rejects(
      new ACPAdapter(adapterOptions(fake, { cancelTimeoutMs: 50 })).run(request(), { signal: controller.signal }),
      (error) => error.details?.kind === "abort",
    );
    assert.equal(cancelSeen, true);
  }
});

test("ACP cancellation without a cancelled terminal acknowledgement is partial", async () => {
  for (const terminalStopReason of [null, "end_turn"]) {
    const controller = new AbortController();
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
      else if (message.method === "session/new") child.respond(message, { sessionId: "unacknowledged-cancel" });
      else if (message.method === "session/prompt") {
        child.respond(message, { messageId: "unacknowledged-user" });
        child.notify("session/update", { sessionId: "unacknowledged-cancel", update: { sessionUpdate: "user_message", messageId: "unacknowledged-user", content: [] } });
        child.notify("session/update", { sessionId: "unacknowledged-cancel", update: { sessionUpdate: "state_update", state: "running" } });
        queueMicrotask(() => controller.abort());
      } else if (message.method === "session/cancel" && terminalStopReason) {
        child.notify("session/update", { sessionId: "unacknowledged-cancel", update: { sessionUpdate: "state_update", state: "idle", stopReason: terminalStopReason } });
      }
    });
    await assert.rejects(
      new ACPAdapter(adapterOptions(fake, { cancelTimeoutMs: 30 })).run(request(), { signal: controller.signal }),
      (error) => {
        assert.equal(error.details?.kind, "cancel-unacknowledged");
        assert.equal(error.details?.uncertain, true);
        return true;
      },
    );
  }
});

test("ACP v1 cancellation is acknowledged only by the pending prompt response", async () => {
  const controller = new AbortController();
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(1));
    else if (message.method === "session/new") child.respond(message, { sessionId: "legacy-cancel" });
    else if (message.method === "session/prompt") queueMicrotask(() => controller.abort());
    else if (message.method === "session/cancel") {
      const prompt = child.received.find((item) => item.method === "session/prompt");
      child.respond(prompt, { stopReason: "cancelled" });
    }
  });
  await assert.rejects(
    new ACPAdapter(adapterOptions(fake, { protocolVersion: 1, cancelTimeoutMs: 50 })).run(request(), { signal: controller.signal }),
    (error) => error.details?.kind === "abort" && error.details?.cancelAcknowledged === true,
  );
});

test("malformed and oversized protocol lines fail with bounded redacted diagnostics", async () => {
  for (const [raw, kind] of [
    ["not-json API_KEY=super-secret-value\n", "transport"],
    [`${"x".repeat(256)}\n`, "output-limit"],
  ]) {
    const fake = createFakeAcpSpawn((_message, child) => child.sendRaw(raw));
    const adapter = new ACPAdapter(adapterOptions(fake, { maxLineBytes: 128 }));
    await assert.rejects(adapter.run(request()), (error) => {
      assert.equal(error.details?.kind, kind);
      assert.doesNotMatch(JSON.stringify(error.details), /super-secret-value/);
      return true;
    });
    assert.equal(fake.children[0].killed, true);
  }
});

test("ACP rejects invalid UTF-8 framing before dispatching a prompt", async () => {
  let promptSeen = false;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") {
      child.sendRaw(Buffer.concat([
        Buffer.from(`{"jsonrpc":"2.0","id":${message.id},"result":{"sessionId":"`),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}}\n'),
      ]));
    } else if (message.method === "session/prompt") {
      promptSeen = true;
      child.respond(message, { messageId: "mutated-user" });
      child.notify("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "user_message", messageId: "mutated-user", content: [] } });
      child.notify("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "state_update", state: "running" } });
      child.notify("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message", messageId: "mutated-answer", content: [{ type: "text", text: "must not run" }] } });
      child.notify("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
    }
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "transport");
    assert.match(error.message, /UTF-8/);
    return true;
  });
  assert.equal(promptSeen, false);
});

test("ACP aggregates JSON-RPC batch responses while applying valid notification siblings", async () => {
  let batchResponse;
  const fake = createFakeAcpSpawn((message, child) => {
    if (Array.isArray(message)) {
      batchResponse = message;
      return;
    }
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "batch-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "batch-user" });
      child.notify("session/update", { sessionId: "batch-session", update: { sessionUpdate: "user_message", messageId: "batch-user", content: [] } });
      child.notify("session/update", { sessionId: "batch-session", update: { sessionUpdate: "state_update", state: "running" } });
      child.send([
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "batch-session", update: { sessionUpdate: "usage_update", used: 2, size: 10 } } },
      ]);
      child.send([
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "batch-session", update: { sessionUpdate: "agent_message", messageId: "batch-answer", content: [{ type: "text", text: "batch complete" }] } } },
        {
          jsonrpc: "2.0", id: "batch-permission", method: "session/request_permission",
          params: {
            sessionId: "batch-session", title: "Run tests",
            subject: { type: "command", command: "npm test", cwd: process.cwd() },
            options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
          },
        },
        { jsonrpc: "2.0", id: "invalid-call", method: 7 },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "batch-session", update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } } },
      ]);
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.result.finalText, "batch complete");
  assert.equal(fake.children[0].received.filter(Array.isArray).length, 1);
  assert.deepEqual(batchResponse, [
    { jsonrpc: "2.0", id: "batch-permission", result: { outcome: { outcome: "selected", optionId: "once" } } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
  ]);
});

test("empty final output and non-success stop reasons remain downstream failures with identity and usage", async () => {
  for (const finalText of ["", "partial answer"]) {
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") child.respond(message, initializeResult(1));
      else if (message.method === "session/new") child.respond(message, { sessionId: "failed-session" });
      else if (message.method === "session/prompt") {
        if (finalText) child.notify("session/update", { sessionId: "failed-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: finalText } } });
        child.notify("session/update", { sessionId: "failed-session", update: { sessionUpdate: "usage_update", used: 9, size: 100 } });
        child.respond(message, { stopReason: finalText ? "max_tokens" : "end_turn" });
      }
    });
    await assert.rejects(new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 })).run(request()), (error) => {
      assert.equal(error.details?.kind, "downstream");
      assert.equal(error.details?.sessionId, "failed-session");
      assert.equal(error.details?.usage.contextWindowUsed, 9);
      return true;
    });
  }
});

test("duplicate incoming request IDs terminate the transport", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "duplicate-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "duplicate-prompt" });
      child.request("same-id", "session/request_permission", {
        sessionId: "duplicate-session", title: "Run", subject: { type: "command" },
        options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
      });
      child.request("same-id", "session/request_permission", {
        sessionId: "duplicate-session", title: "Run again", subject: { type: "command" },
        options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
      });
    }
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "transport");
    assert.match(error.message, /duplicate/i);
    return true;
  });
});

test("ACP acknowledges native session close before stdio teardown when supported", async () => {
  for (const protocolVersion of [2, 1]) {
    const sessionId = `close-v${protocolVersion}`;
    const fake = createFakeAcpSpawn((message, child) => {
      if (message.method === "initialize") {
        child.respond(message, protocolVersion === 2
          ? initializeResult(2, { session: {} })
          : initializeResult(1, { sessionCapabilities: { close: {} } }));
      } else if (message.method === "session/new") child.respond(message, { sessionId });
      else if (message.method === "session/prompt" && protocolVersion === 1) {
        child.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "closed safely" } } });
        child.respond(message, { stopReason: "end_turn" });
      } else if (message.method === "session/prompt") {
        child.respond(message, { messageId: "close-user" });
        child.notify("session/update", { sessionId, update: { sessionUpdate: "user_message", messageId: "close-user", content: [] } });
        child.notify("session/update", { sessionId, update: { sessionUpdate: "state_update", state: "running" } });
        child.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message", messageId: "close-answer", content: [{ type: "text", text: "closed safely" }] } });
        child.notify("session/update", { sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
      }
    });
    const output = await new ACPAdapter(adapterOptions(fake, { protocolVersion })).run(request());
    assert.equal(output.result.finalText, "closed safely");
    const close = fake.children[0].received.find((message) => message.method === "session/close");
    assert.deepEqual(close?.params, { sessionId });
  }
});

test("ACP rejects an otherwise completed result when native session close is unacknowledged", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: "unclosed-session" });
    else if (message.method === "session/prompt") {
      child.respond(message, { messageId: "unclosed-user" });
      child.notify("session/update", { sessionId: "unclosed-session", update: { sessionUpdate: "user_message", messageId: "unclosed-user", content: [] } });
      child.notify("session/update", { sessionId: "unclosed-session", update: { sessionUpdate: "state_update", state: "running" } });
      child.notify("session/update", { sessionId: "unclosed-session", update: { sessionUpdate: "agent_message", messageId: "unclosed-answer", content: [{ type: "text", text: "must reject" }] } });
      child.notify("session/update", { sessionId: "unclosed-session", update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
    }
  }, { autoClose: false });
  await assert.rejects(
    new ACPAdapter(adapterOptions(fake, { cleanupTimeoutMs: 30 })).run(request()),
    (error) => {
      assert.equal(error.details?.kind, "transport");
      assert.equal(error.details?.unsafeResume, true);
      assert.equal(error.details?.cleanupError?.[0]?.component, "session");
      return true;
    },
  );
});

test("ACP preserves opaque native session identity byte-for-byte", async () => {
  const sessionId = " session/opaque-id ";
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId });
    else if (message.method === "session/prompt") {
      assert.equal(message.params.sessionId, sessionId);
      child.respond(message, { messageId: "opaque-user" });
      child.notify("session/update", { sessionId, update: { sessionUpdate: "user_message", messageId: "opaque-user", content: [] } });
      child.notify("session/update", { sessionId, update: { sessionUpdate: "state_update", state: "running" } });
      child.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message", messageId: "opaque-answer", content: [{ type: "text", text: "identity preserved" }] } });
      child.notify("session/update", { sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
    }
  });
  const output = await new ACPAdapter(adapterOptions(fake)).run(request());
  assert.equal(output.sessionId, sessionId);
  assert.equal(fake.children[0].received.find((message) => message.method === "session/close")?.params.sessionId, sessionId);
});

test("ACP rejects a redaction-changing native session identity before prompt and still closes it", async () => {
  const sessionId = "token=fake-native-session-secret";
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId });
  });
  await assert.rejects(new ACPAdapter(adapterOptions(fake)).run(request()), (error) => {
    assert.equal(error.details?.kind, "protocol");
    assert.match(error.message, /sessionId/);
    assert.doesNotMatch(JSON.stringify(error), /fake-native-session-secret/);
    return true;
  });
  assert.equal(fake.children[0].received.some((message) => message.method === "session/prompt"), false);
  assert.equal(fake.children[0].received.find((message) => message.method === "session/close")?.params.sessionId, sessionId);
});

test("ACP retains and closes a validated session identity observed before a lost session/new response", async () => {
  const sessionId = "provisional-before-response";
  let promptSeen = false;
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") {
      child.notify("session/update", { sessionId, update: { sessionUpdate: "usage_update", used: 1, size: 10 } });
    } else if (message.method === "session/prompt") promptSeen = true;
  });
  await assert.rejects(
    new ACPAdapter(adapterOptions(fake, { startupTimeoutMs: 30, cleanupTimeoutMs: 50 })).run(request()),
    (error) => {
      assert.equal(error.details?.kind, "timeout");
      assert.equal(error.details?.sessionId, sessionId);
      return true;
    },
  );
  assert.equal(promptSeen, false);
  assert.equal(fake.children[0].received.find((message) => message.method === "session/close")?.params.sessionId, sessionId);
});

test("ACP rejects nonblank bounds violations for new and resume session identities before prompt", async () => {
  const oversized = "s".repeat(1_001);
  const created = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(2, { session: {} }));
    else if (message.method === "session/new") child.respond(message, { sessionId: oversized });
  });
  await assert.rejects(new ACPAdapter(adapterOptions(created)).run(request()), (error) => {
    assert.equal(error.details?.kind, "protocol");
    assert.equal(error.details?.field, "sessionId");
    return true;
  });
  assert.equal(created.children[0].received.some((message) => message.method === "session/prompt"), false);
  assert.equal(created.children[0].received.find((message) => message.method === "session/close")?.params.sessionId, oversized);

  for (const invalidResumeId of ["   ", oversized]) {
    const resumed = createFakeAcpSpawn(() => {});
    await assert.rejects(
      new ACPAdapter(adapterOptions(resumed)).run(request({ execution: { sessionId: invalidResumeId } })),
      (error) => error.details?.kind === "protocol" && error.details?.field === "sessionId",
    );
    assert.equal(resumed.calls.length, 0);
  }
});

test("a completed result is rejected when owned client-service cleanup fails", async () => {
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(1));
    else if (message.method === "session/new") child.respond(message, { sessionId: "cleanup-session" });
    else if (message.method === "session/prompt") {
      child.notify("session/update", { sessionId: "cleanup-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cannot accept yet" } } });
      child.respond(message, { stopReason: "end_turn" });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake, {
    protocolVersion: 1,
    clientServicesFactory: () => ({
      capabilities: {},
      async handleRequest() { return {}; },
      async close() { throw new Error("terminal still active"); },
    }),
  }));
  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "transport");
    assert.equal(error.details?.unsafeResume, true);
    assert.equal(error.details?.cleanupError?.[0]?.component, "client-services");
    return true;
  });
});

test("control supports only native cancellation while a run is active", async () => {
  let release;
  const promptStarted = new Promise((resolve) => { release = resolve; });
  const fake = createFakeAcpSpawn((message, child) => {
    if (message.method === "initialize") child.respond(message, initializeResult(1));
    else if (message.method === "session/new") child.respond(message, { sessionId: "control-session" });
    else if (message.method === "session/prompt") release();
    else if (message.method === "session/cancel") {
      const prompt = child.received.find((item) => item.method === "session/prompt");
      child.respond(prompt, { stopReason: "cancelled" });
    }
  });
  const adapter = new ACPAdapter(adapterOptions(fake, { protocolVersion: 1 }));
  const running = adapter.run(request());
  await promptStarted;
  await assert.rejects(adapter.control({ kind: "reroute", route: { model: "x" } }), (error) => error.details?.kind === "unsupported-control");
  const acknowledgement = await adapter.control({ kind: "cancel" });
  assert.equal(acknowledgement.delivery, "native");
  await assert.rejects(running, (error) => error.details?.kind === "abort");
});

test("adapter errors have a stable public shape", () => {
  const error = new AcpAdapterError("no", "policy", { field: "route.model" });
  assert.equal(error.name, "AcpAdapterError");
  assert.deepEqual(error.details, { kind: "policy", field: "route.model" });
});
