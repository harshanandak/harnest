import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { structuredResult } from "../src/result.mjs";

test("malformed completion braces cannot block the event loop indefinitely", () => {
  const script = `
    const { structuredResult } = await import(${JSON.stringify(new URL("../src/result.mjs", import.meta.url).href)});
    const text = '{'.repeat(4000) + '"finalText": invalid' + '}'.repeat(4000);
    const result = structuredResult(text);
    if (result.finalText !== text) process.exit(2);
    console.log('PARSER_OK');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 3000, windowsHide: true,
  });
  assert.equal(child.error, undefined, `parser child failed: ${child.error?.code}`);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /PARSER_OK/);
});

test("completion scanning handles quoted braces, fenced output and nested envelopes", () => {
  const fixtures = [
    ['Preamble { unmatched\n```json\n{"finalText":"DONE", "tests":["literal } { and \\\"quote\\\""]}\n```', "DONE"],
    ['{"outer":{"finalText":"INNER"}}', "INNER"],
    ['{"finalText":"FIRST"}\n{"finalText":"LAST"}', "LAST"],
    ['Prose says "finalText" but is not an envelope.', 'Prose says "finalText" but is not an envelope.'],
  ];
  for (const [text, finalText] of fixtures) assert.equal(structuredResult(text).finalText, finalText);
});
