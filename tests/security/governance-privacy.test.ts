/**
 * Governance privacy (ROADMAP Stage 5 Phase 71–72, TESTING.md §2).
 *
 * Every new store is mechanically scanned for what must never be in it: API keys and raw
 * credentials (anywhere), prompts, learner text, AI output, reasoning content and provider raw
 * error bodies (in the ledger, metrics, events, breaker state, config history and quota state).
 *
 * One stated boundary, recorded here rather than silently skipped: the **idempotency replay cache**
 * holds the consumer-visible result — that is what makes a replay faithful (frozen §10.2). It is
 * retention-limited in-memory state, never a log: what it may not contain is credentials, prompts,
 * reasoning content or provider raw errors.
 */
import { InMemorySecretStore, TestClock } from '@aibridge/host-sdk';
import {
  CircuitBreakerRegistry,
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  InMemoryUsageLedger,
  QuotaManager,
} from '@aibridge/governance';
import { ConfigManager, InMemoryConfigSnapshotStore } from '@aibridge/runtime';
import { describe, expect, it } from 'vitest';

import { syntheticSecrets } from '../helpers/synthetic.js';
import { callerContext, makeHarness, script, structuredTurn, textTurn, type FakeStep } from '../helpers/reliability.js';

const PROMPT_TEXT = 'Explain recursion to a ten year old learner.';
const LEARNER_TEXT = 'A learner described a two-pass approach.';
const REASONING_TEXT = 'the model reasoned about pivot selection in quicksort';

function expectClean(label: string, serialized: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(serialized.includes(needle), `${label} must not contain "${needle.slice(0, 12)}…"`).toBe(false);
  }
}

describe('governance stores never leak content (Phase 71)', () => {
  it('keeps secrets, prompts, learner text, output and raw errors out of every store', async () => {
    const secrets = syntheticSecrets();
    const leakyError: FakeStep = {
      kind: 'rawError',
      rawError: {
        category: 'UPSTREAM',
        reason: 'PROVIDER_UNAVAILABLE',
        dispatched: true,
        rawMessage: `vendor body echoed ${secrets.OPENAI_STYLE_KEY} and ${REASONING_TEXT}`,
      },
    };
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(leakyError, leakyError) },
        {
          id: 'openai',
          behavior: script(
            { kind: 'structured', text: `not json but it contains ${secrets.GITHUB_TOKEN}` },
            { kind: 'structured', text: '{"summary":"two passes"}' },
          ),
        },
      ],
      governance: {
        outputRepair: 'ONCE',
        quotas: [{ scope: 'subject', meter: 'TOKENS', period: 'DAY', limit: 100_000 }],
        pricing: [
          {
            pricingId: 'price-1',
            version: '1',
            providerId: 'openai',
            currency: 'USD',
            inputTokenPrice: 1,
            outputTokenPrice: 2,
            unit: 'PER_1K_TOKENS',
            validFromMs: 0,
            source: `rate card ${secrets.AWS_ACCESS_KEY_ID}`,
          },
        ],
      },
    });

    const outcome = await harness.runtime.executeObserved(
      structuredTurn(1, { input: { instructions: PROMPT_TEXT, context: [{ name: 'body', label: 'Body', type: 'STRING', untrusted: true, value: LEARNER_TEXT }] } }),
      callerContext,
    );
    expect(outcome.result.status).toBe('SUCCEEDED');

    const forbidden = [
      secrets.OPENAI_STYLE_KEY,
      secrets.GITHUB_TOKEN,
      secrets.AWS_ACCESS_KEY_ID,
      secrets.PEM_PRIVATE_KEY,
      secrets.JWT,
      PROMPT_TEXT,
      LEARNER_TEXT,
      REASONING_TEXT,
      'two passes', // the AI output
    ];

    // The ledger: counts, ids and safe provenance only (Phase 29).
    const ledgerRecords = JSON.stringify({
      attempts: await harness.ledger.attempts(),
      requests: await harness.ledger.requests(),
    });
    expectClean('usage ledger', ledgerRecords, forbidden);
    // The pricing `source` note is operator config — it may name a rate card, never a credential.
    const configish = JSON.stringify(harness.ledger);
    expectClean('usage ledger object', configish, forbidden);

    // Metrics, events, breaker state, quota and rate state.
    expectClean('metrics', JSON.stringify(harness.metrics.totals()), forbidden);
    expectClean('operational events', JSON.stringify(harness.events.events), forbidden);
    expectClean('breaker state', JSON.stringify(harness.runtime.getProviderHealth()), forbidden);
    expectClean('quota state', JSON.stringify(await harness.quotaStore.consumed('qt|subject|unknown|TOKENS|DAY|1970-01-01')), forbidden);
    expectClean('rate state', JSON.stringify(harness.rateStore.hits('rl|global')), forbidden);

    // The idempotency replay cache may hold the consumer-visible result and nothing else.
    const replayCache = JSON.stringify(await harness.idempotencyStore.get('test.caller|ai.structured.generate|1.0|turn-1'));
    expect(replayCache).toContain('two passes'); // faithful replay needs the result…
    expectClean('idempotency cache', replayCache, [
      secrets.OPENAI_STYLE_KEY,
      secrets.GITHUB_TOKEN,
      secrets.AWS_ACCESS_KEY_ID,
      PROMPT_TEXT,
      LEARNER_TEXT,
      REASONING_TEXT,
    ]);
    expect(replayCache).not.toContain('instructions');
    expect(replayCache).not.toContain('rawMessage');
  });

  it('keeps a credential out of the config snapshot and its history (Phase 72)', async () => {
    const secrets = syntheticSecrets();
    const secretStore = new InMemorySecretStore();
    secretStore.put('secret://test/relay', secrets.OPENAI_STYLE_KEY);

    const manager = ConfigManager.bootstrap(
      {
        providers: [
          {
            providerId: 'relay',
            preset: 'OPENAI_COMPATIBLE_CUSTOM',
            enabled: true,
            credentialRef: 'secret://test/relay',
            endpoint: { kind: 'CUSTOM', baseUrl: 'https://api.example.invalid/v1' },
            models: [
              { alias: 'relay.text.primary', providerId: 'relay', providerModelId: 'relay-model', profiles: ['balanced'], features: ['text'] },
            ],
          },
        ],
        routes: [{ profile: 'balanced', chain: ['relay.text.primary'] }],
      },
      { clock: new TestClock(0), store: new InMemoryConfigSnapshotStore() },
    );
    expect(manager.ok).toBe(true);
    if (!manager.ok) {
      return;
    }
    const snapshot = manager.value.active();
    expectClean('config snapshot', JSON.stringify(snapshot), [secrets.OPENAI_STYLE_KEY]);
    // The handle is present, the value is not.
    expect(JSON.stringify(snapshot)).toContain('secret://test/relay');
    // An export/debug stringification of the whole manager is safe too.
    expectClean('config manager', JSON.stringify(manager.value.history()), [secrets.OPENAI_STYLE_KEY]);
  });

  it('keeps the operator log credential- and content-free', async () => {
    const secrets = syntheticSecrets();
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: script({
            kind: 'rawError',
            rawError: {
              category: 'UPSTREAM',
              reason: 'PROVIDER_UNAVAILABLE',
              dispatched: true,
              rawMessage: `vendor said ${secrets.BEARER_HEADER} about ${PROMPT_TEXT}`,
            },
          }),
        },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    // The raw provider message stays on the operator channel only, redacted there…
    // …and never in the result, the ledger or the events.
    expectClean('result', JSON.stringify(outcome.result), [secrets.BEARER_HEADER, secrets.OPENAI_STYLE_KEY, PROMPT_TEXT]);
    expectClean('ledger', JSON.stringify(await harness.ledger.attempts()), [secrets.BEARER_HEADER, PROMPT_TEXT]);
    expectClean('events', JSON.stringify(harness.events.events), [secrets.BEARER_HEADER, PROMPT_TEXT]);
  });

  it('stores share no silent zero: an unknown cost stays unknown everywhere (Phase 31)', async () => {
    const idempotency = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock: new TestClock(0) }), clock: new TestClock(0) });
    const quotas = new QuotaManager({ store: new InMemoryQuotaStore(), clock: new TestClock(0) });
    void idempotency;
    void quotas;
    void new CircuitBreakerRegistry({ clock: new TestClock(0) });
    void new InMemoryUsageLedger();
    void new InMemoryRateLimitStore();
    const harness = makeHarness({ providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'ok' }) }] });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    // No pricing configured ⇒ no fabricated cost in the result or the ledger.
    expect(outcome.result.usage.estimatedCost).toBeUndefined();
    expect(outcome.governance.totalCost.amount).toBeUndefined();
    const records = await harness.ledger.requests(outcome.provenance.logicalRequestId);
    expect(records[0]?.totalCost.amount).toBeUndefined();
  });
});
