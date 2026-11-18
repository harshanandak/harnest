import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boundedProviderText, classifyProviderFailure, mergeProcessEnv, redactSecrets } from "../src/process.mjs";

test("classifyProviderFailure maps auth, billing and region to provider-auth", () => {
  assert.equal(classifyProviderFailure({ type: "provider.auth", message: "no" }).kind, "provider-auth");
  assert.equal(classifyProviderFailure({ message: "Authentication required." }).kind, "provider-auth");
  assert.equal(classifyProviderFailure({ message: "not authenticated" }).kind, "provider-auth");
  assert.equal(classifyProviderFailure({ status: 401, message: "unauthorized" }).kind, "provider-auth");
  assert.equal(classifyProviderFailure({ message: "Insufficient balance. Manage your billing here." }).category, "billing");
  assert.equal(classifyProviderFailure({ message: "this model requires explicit regional opt-in" }).category, "region");
  assert.equal(classifyProviderFailure({ message: "invalid api key" }).kind, "provider-auth");
});

test("classifyProviderFailure maps model problems to unavailable", () => {
  assert.equal(classifyProviderFailure({ type: "model.not_found", message: "" }).kind, "unavailable");
  assert.equal(classifyProviderFailure({ message: "unknown model gpt-9" }).kind, "unavailable");
  assert.equal(classifyProviderFailure({ message: "unsupported model for this endpoint" }).kind, "unavailable");
  assert.equal(classifyProviderFailure({ type: "model.unsupported", message: "" }).kind, "unavailable");
  assert.equal(classifyProviderFailure({ message: "the model does not exist" }).kind, "unavailable");
});

test("classifyProviderFailure stays silent when the evidence does not fit", () => {
  assert.equal(classifyProviderFailure({ message: "process exited with code 1" }), null);
  assert.equal(classifyProviderFailure({ type: "stream.error", message: "connection reset by peer" }), null);
  assert.equal(classifyProviderFailure({}), null);
});

test("boundedProviderText redacts credentials and truncates", () => {
  const redacted = boundedProviderText("failed with key sk-abcdefghijklmnopqrstuvwxyz and authorization: Bearer abc.def.ghi");
  assert.ok(!redacted.includes("sk-abcdefghijklmnopqrstuvwxyz"), redacted);
  assert.ok(!redacted.includes("abc.def.ghi"), redacted);
  assert.ok(boundedProviderText("x".repeat(1000)).length <= 401);
});

test("boundedProviderText removes authorization payloads before truncation and on repeated passes", () => {
  const sentinel = "synthetic_authorization_payload";
  for (const scheme of ["Bearer", "Basic", "bEaReR", "bAsIc"]) {
    for (const input of [
      `HTTP 401 Authorization: ${scheme} ${sentinel}`,
      `AUTHORIZATION \t=\t ${scheme}\t${sentinel}`,
      `{"Authorization": "${scheme} ${sentinel}", "status": 401}`,
      `{'authorization': '${scheme} ${sentinel}'}`,
      `Authorization: ${scheme} '${sentinel}'`,
      `Authorization: ${scheme} "${sentinel}"`,
      `${scheme} ${sentinel}`,
      `Authorization: ${scheme} ${sentinel}${"x".repeat(1000)}`,
    ]) {
      const redacted = boundedProviderText(input);
      assert.ok(!redacted.includes(sentinel), `payload survived: ${redacted}`);
      assert.equal(boundedProviderText(redacted), redacted);
    }
  }
});

test("redactSecrets preserves surrounding whitespace and quoted JSON structure", () => {
  const text = '\t{\n  "AUTHORIZATION" : "bAsIc synthetic_payload",\n  "token": "synthetic quoted value",\n  "message": "HTTP 401"\n}\n';
  const expected = '\t{\n  "AUTHORIZATION" : "[REDACTED]",\n  "token": "[REDACTED]",\n  "message": "HTTP 401"\n}\n';
  assert.equal(redactSecrets(text), expected);
  assert.equal(redactSecrets(expected), expected);
  assert.equal(JSON.parse(redactSecrets(text)).message, "HTTP 401");
  assert.equal(redactSecrets("  no\tcredentials\r\nhere  "), "  no\tcredentials\r\nhere  ");
  for (const value of [undefined, null, {}, 123]) assert.equal(redactSecrets(value), "");
});

test("JSON-escaped authorization quotes cannot leave the payload behind", () => {
  const sentinel = "synthetic_review_sentinel";
  const input = JSON.stringify({ message: `Authorization: Bearer "${sentinel}"` });
  const once = boundedProviderText(input);
  const twice = boundedProviderText(once);
  assert.equal(once.includes(sentinel), false);
  assert.equal(twice.includes(sentinel), false);
  assert.equal(twice, once);
});

test("unterminated authorization quotes cannot leave the payload behind", () => {
  const sentinel = "synthetic_review_sentinel";
  const input = `Authorization: Bearer "${sentinel}`;
  const once = boundedProviderText(input);
  const twice = boundedProviderText(once);
  assert.equal(once.includes(sentinel), false);
  assert.equal(twice.includes(sentinel), false);
  assert.equal(twice, once);
});

test("authorization redaction handles repeated JSON escaping without changing benign diagnostics", () => {
  const sentinel = "synthetic_review_sentinel";
  for (const scheme of ["Bearer", "Basic", "bEaReR", "bAsIc"]) {
    for (const quote of ['"', "'"]) {
      for (const terminated of [false, true]) {
        const prefix = `\tHTTP 401 Authorization:\t${scheme} `;
        const suffix = "\n  keep the diagnostic context\t";
        const diagnostic = `${prefix}${quote}${sentinel}${terminated ? quote : ""}${suffix}`;
        let input = JSON.stringify({ message: diagnostic, status: 401 }, null, 2);
        for (let depth = 0; depth < 4; depth++) {
          const redacted = redactSecrets(input);
          assert.equal(redacted.includes(sentinel), false, `scheme=${scheme}, quote=${quote}, terminated=${terminated}, depth=${depth}`);
          assert.equal(redactSecrets(redacted), redacted);
          const bounded = boundedProviderText(input);
          assert.equal(bounded.includes(sentinel), false);
          assert.equal(boundedProviderText(bounded), bounded);
          let decoded = redacted;
          for (let i = 0; i < depth; i++) decoded = JSON.parse(decoded);
          const parsed = JSON.parse(decoded);
          assert.equal(parsed.status, 401);
          assert.equal(parsed.message, `\tHTTP 401 Authorization:\t${quote}[REDACTED]${terminated ? quote : ""}${suffix}`);
          input = JSON.stringify(input);
        }
      }
    }
  }
});

test("incomplete escaped values and escaped quotes inside values are fully redacted", () => {
  const sentinel = "synthetic_review_sentinel";
  for (const scheme of ["Bearer", "Basic"]) {
    for (const slashes of [0, 1, 3, 7]) {
      const input = `Authorization: ${scheme} ${"\\".repeat(slashes)}"${sentinel}`;
      const redacted = redactSecrets(input);
      assert.equal(redacted.includes(sentinel), false);
      assert.equal(redactSecrets(redacted), redacted);
    }
    const input = JSON.stringify({ message: `Authorization: ${scheme} "synthetic\\"${sentinel}\\\\"; retry later` });
    const redacted = redactSecrets(input);
    assert.equal(redacted.includes(sentinel), false);
    assert.ok(JSON.parse(redacted).message.endsWith("; retry later"));
    assert.equal(redactSecrets(redacted), redacted);
  }
});

test("redaction preserves benign quoted text and JSON formatting", () => {
  for (const text of [
    '\tHTTP 401: "retry later"\r\n  Authorization checks failed.\t',
    '{\n  "message" : "Authorization checks failed; retry later",\n  "status": 401\n}\n',
    JSON.stringify({ message: 'HTTP 401: "retry later"', status: 401 }, null, 2),
    String.raw`"HTTP 401: malformed JSON escape \N; retry later"`,
  ]) assert.equal(redactSecrets(text), text);
});

test("escaped JSON field names and malformed escaped diagnostics remain safe", () => {
  const sentinel = "synthetic_review_sentinel";
  const input = `{"authoriz\\u0061tion":"Basic ${sentinel}","status":401}`;
  assert.deepEqual(JSON.parse(redactSecrets(input)), { authorization: "[REDACTED]", status: 401 });
  const malformed = `"HTTP 401 \\N Authorization: Bearer '${sentinel}'; retry later"`;
  const redacted = redactSecrets(malformed);
  assert.equal(redacted, '"HTTP 401 \\N Authorization: \'[REDACTED]\'; retry later"');
  assert.equal(redactSecrets(redacted), redacted);
});

test("truncated escaped strings are scanned within an external deadline", { timeout: 3000 }, async (t) => {
  const runner = fileURLToPath(new URL("./fixtures/process-runner.mjs", import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [runner, "redaction-cost"], { timeout: 1500 });
  assert.equal(stderr, "");
  const measured = JSON.parse(stdout);
  assert.ok(measured.bytes > 128_000);
  assert.ok(measured.elapsedMs < 1000, `redaction took ${measured.elapsedMs} ms`);
  t.diagnostic(JSON.stringify(measured));
});

test("mergeProcessEnv inherits the parent environment and merges overrides", () => {
  const lookup = (source, key) => {
    const found = Object.keys(source).find((entry) => entry.toLowerCase() === key.toLowerCase());
    return found ? source[found] : undefined;
  };
  const env = mergeProcessEnv({ HARNEST_TEST_OVERRIDE: "merged" });
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA"]) {
    const original = lookup(process.env, key);
    if (original !== undefined) assert.equal(lookup(env, key), original, key);
  }
  assert.equal(env.HARNEST_TEST_OVERRIDE, "merged");
  assert.equal(process.env.HARNEST_TEST_OVERRIDE, undefined, "the parent environment is not mutated");
});
