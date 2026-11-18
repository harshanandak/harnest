import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { __testing } from '../src/adapters/gemini-policy.mjs';

// Native policy verification stays outside consumer dependencies and never
// loads a user's settings, authenticates, executes tools, or starts inference.
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-gemini-native-policy.mjs <installed-gemini-cli-core-directory>');
const nativeRoot = resolve(process.argv[2]);
const packageJson = JSON.parse(await readFile(join(nativeRoot, 'package.json'), 'utf8'));
assert.equal(packageJson.name, '@google/gemini-cli-core');
assert.equal(packageJson.version, '0.62.0');
const loadNative = (file) => import(pathToFileURL(join(nativeRoot, 'dist', 'src', file)).href);
const { PolicyEngine } = await loadNative('policy/policy-engine.js');
const { createPolicyEngineConfig } = await loadNative('policy/config.js');
const { Storage } = await loadNative('config/storage.js');
const { ApprovalMode, PolicyDecision } = await loadNative('policy/types.js');
const directory = await mkdtemp(join(tmpdir(), 'harnest-native-policy-case-'));
const userDir = join(directory, 'user');
const adminDir = join(directory, 'admin');
const systemDir = join(directory, 'system');
await Promise.all([userDir, adminDir, systemDir].map(path => mkdir(path)));
const originalSystem = Storage.getSystemPoliciesDir;
const originalUser = Storage.getUserPoliciesDir;
Storage.getSystemPoliciesDir = () => systemDir;
Storage.getUserPoliciesDir = () => userDir;
let checks = 0;
try {
  await writeFile(join(userDir, 'widen.toml'), '[[rule]]\ntoolName="*"\ndecision="allow"\npriority=999\n');
  for (const write of [false, true]) {
    await writeFile(join(adminDir, 'harnest.toml'), __testing.policyToml(write));
    const settings = JSON.parse(__testing.settingsJson(write));
    const config = await createPolicyEngineConfig({ ...settings, policyPaths: [userDir], adminPolicyPaths: [adminDir] }, ApprovalMode.DEFAULT, undefined, false);
    const engine = new PolicyEngine(config);
    for (const tool of __testing.READ_TOOLS) {
      const decision = await engine.check({ name: tool, args: {} });
      assert.equal(decision.decision, PolicyDecision.ALLOW, `read tool ${tool} write=${write}`);
      checks++;
    }
    for (const tool of __testing.WRITE_TOOLS) {
      const decision = await engine.check({ name: tool, args: tool === 'run_shell_command' ? { command: 'node --version' } : {} });
      assert.equal(decision.decision, write ? PolicyDecision.ALLOW : PolicyDecision.DENY, `coding tool ${tool} write=${write}`);
      checks++;
    }
    for (const tool of ['exit_plan_mode', 'enter_plan_mode', 'invoke_agent', 'unknown_future_tool', 'mcp_example_mutate']) {
      const decision = await engine.check({ name: tool, args: {} });
      assert.equal(decision.decision, PolicyDecision.DENY, `escape/unknown tool ${tool} write=${write}`);
      checks++;
    }
  }
  process.stdout.write(JSON.stringify({ version: packageJson.version, checks, result: 'PASS', inference: false, executedTools: false }) + '\n');
} finally {
  Storage.getSystemPoliciesDir = originalSystem;
  Storage.getUserPoliciesDir = originalUser;
  await rm(directory, { recursive: true, force: true });
}
