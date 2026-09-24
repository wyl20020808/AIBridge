#!/usr/bin/env node
/**
 * Packed-artifact host qualification (Stage 6).
 *
 * Proves that the artifacts an operator installs actually boot and serve — no repo aliases, no
 * source-tree imports, no network beyond loopback:
 *
 *  1. `npm pack` every runtime package into a temp directory.
 *  2. `npm install` the tarballs into a clean prefix (the operator's exact install path).
 *  3. Drive the packed `@aibridge/host` + `@aibridge/suite-all` through a real `execute` against
 *     a loopback OpenAI-compatible fake, covering: a SUCCEEDED call with usage and the resolved
 *     bearer credential, idempotent replay (no second dispatch), kill-switch gating through an
 *     atomic reload, and disposal.
 *
 * Exit code 0 = the packed host is qualified. Any failure exits non-zero with the failing step.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The full runtime dependency closure, in dependency order. */
const PACKAGES = [
  'contracts',
  'core',
  'host-sdk',
  'governance',
  'runtime',
  'provider-openai-compatible',
  'provider-openai',
  'provider-deepseek',
  'provider-xiaomi-tokenplan',
  'host',
  'suite-all',
];

const fail = (step, error) => {
  console.error(`PACKED HOST QUALIFICATION FAILED at ${step}: ${error}`);
  process.exit(1);
};

const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

/** npm is a .cmd shim on Windows: it must go through the system shell. */
const runNpm = (args) =>
  execSync(`npm ${args.map(quote).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/* 1 ── pack ──────────────────────────────────────────────────────────────────────────── */

const work = mkdtempSync(join(tmpdir(), 'aibridge-packed-'));
const tarballs = join(work, 'tarballs');
const app = join(work, 'app');
mkdirSync(tarballs);
mkdirSync(app);

const packed = [];
for (const name of PACKAGES) {
  const directory = join(root, 'packages', name);
  if (!existsSync(join(directory, 'dist', 'index.js'))) {
    fail('precondition', `packages/${name}/dist is missing — run the build first (npm run build)`);
  }
  const output = runNpm(['pack', directory, '--pack-destination', tarballs]).trim();
  const file = output.split('\n').at(-1).trim();
  packed.push(join(tarballs, file));
}

/* 2 ── clean install (the operator path) ─────────────────────────────────────────────── */

try {
  runNpm(['install', '--prefix', app, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...packed]);
} catch (error) {
  fail('install', error.stderr ?? error.message);
}

/* 3 ── drive the packed modules ──────────────────────────────────────────────────────── */

const driver = String.raw`
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = process.argv[2];
const assert = (condition, message) => {
  if (!condition) {
    console.error('driver assertion failed: ' + message);
    process.exit(1);
  }
};

const load = (spec) => import(pathToFileURL(join(appDir, 'node_modules', spec, 'dist', 'index.js')).href);
const host = await load('@aibridge/host');
const suite = await load('@aibridge/suite-all');

let hits = 0;
let lastAuth = null;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    hits += 1;
    lastAuth = request.headers['authorization'] ?? null;
    const payload = JSON.parse(body);
    assert(payload.model === 'fake-model-1', 'adapter must send the configured provider model id');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-packed',
      object: 'chat.completion',
      created: 1,
      model: 'fake-model-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'PACKED_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }));
  });
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;

const config = {
  providers: [{
    providerId: 'fake-gateway',
    preset: 'OPENAI_COMPATIBLE_CUSTOM',
    enabled: true,
    credentialRef: 'secret://env/PACKED_FAKE_KEY',
    endpoint: { kind: 'CUSTOM', baseUrl: 'http://127.0.0.1:' + port + '/v1' },
    authScheme: 'BEARER',
    wireProtocol: 'OPENAI_CHAT_COMPLETIONS',
    allowPrivateNetworkForDevelopment: true,
    models: [{
      alias: 'fake.fast.default',
      providerId: 'fake-gateway',
      providerModelId: 'fake-model-1',
      profiles: ['fast', 'balanced', 'reasoning'],
      features: ['text', 'structuredJson', 'usage'],
    }],
  }],
  routes: [
    { profile: 'fast', chain: ['fake.fast.default'] },
    { profile: 'balanced', chain: ['fake.fast.default'] },
    { profile: 'reasoning', chain: ['fake.fast.default'] },
  ],
  governance: {},
};

const created = await host.createAiBridgeServerPlugin({
  config,
  adapterFactories: suite.SUITE_ADAPTER_FACTORIES,
  resolveEndpoint: suite.suiteResolveEndpoint,
  secrets: {
    resolve: (handle) => Promise.resolve(handle === 'secret://env/PACKED_FAKE_KEY' ? 'packed-fake-key' : null),
    has: (handle) => Promise.resolve(handle === 'secret://env/PACKED_FAKE_KEY'),
  },
});
assert(created.ok === true, 'plugin construction must succeed: ' + JSON.stringify(created.failure ?? null));
const plugin = created.value;

const envelope = {
  contractVersion: '1.1',
  requestId: 'packed-e2e-1',
  idempotencyKey: 'packed-turn-1',
  capability: 'ai.text.generate',
  capabilityVersion: '1.0',
  profile: 'fast',
  input: {
    instructions: 'Reply with exactly: PACKED_OK',
    context: [{ name: 'topic', label: 'Topic', type: 'STRING', untrusted: false, value: 'qualification' }],
  },
};
const trusted = {
  callerPluginId: 'site.problem',
  grantedPermissions: ['ai.text.generate@1.x'],
  subjectToken: 'ojs1_packedqualificationtoken',
};

const first = await plugin.execute(envelope, trusted);
assert(first.status === 'SUCCEEDED', 'first call must succeed: ' + JSON.stringify(first.error ?? null));
assert(typeof first.output?.text === 'string', 'output must carry text');
assert(first.usage?.totalTokens === 15, 'usage must flow from the provider response');
assert(hits === 1, 'exactly one provider dispatch');
assert(lastAuth === 'Bearer packed-fake-key', 'the resolved credential must reach the provider as Bearer');

const replay = await plugin.execute(envelope, trusted);
assert(replay.status === 'SUCCEEDED', 'replay must succeed');
assert(hits === 1, 'idempotent replay must not dispatch a second provider call, got ' + hits);

const reloaded = await plugin.reload({
  ...config,
  governance: { killSwitch: { global: true, providers: [], capabilities: [] } },
});
assert(reloaded.ok === true, 'atomic reload must succeed');
const denied = await plugin.execute(
  { ...envelope, requestId: 'packed-e2e-2', idempotencyKey: 'packed-turn-2' },
  trusted,
);
assert(denied.status === 'FAILED' && denied.error?.reason === 'KILL_SWITCH_GLOBAL',
  'kill switch must gate execution: ' + JSON.stringify(denied.error ?? null));
assert(hits === 1, 'killed execution must not dispatch');

plugin.dispose();
server.close();
console.log('PACKED HOST QUALIFICATION PASS: packed artifacts boot, serve, replay idempotently, and gate on the kill switch.');
`;

writeFileSync(join(app, 'driver.mjs'), driver);
try {
  const output = run('node', [join(app, 'driver.mjs'), app]);
  process.stdout.write(output);
} catch (error) {
  fail('execute', `${error.message}\n${error.stderr ?? ''}\n${error.stdout ?? ''}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
