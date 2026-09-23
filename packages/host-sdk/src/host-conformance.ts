/**
 * The host conformance kit (TESTING.md §1, ROADMAP Stage 2).
 *
 * Every host that AI Bridge attaches to must pass the same suite unchanged. An adapter that needs an
 * exemption has a design problem. The suite is deliberately small: it asserts the properties whose
 * violation is a security incident, not style.
 *
 * The mutant hosts in `fakes.ts` exist so this kit can be shown to *fail* on a bad host. A
 * conformance suite that has never failed is decoration.
 */
import { CALLER_PLUGIN_ID_PATTERN, isOpaqueSubjectToken, parseKillSwitchState } from '@aibridge/contracts';
import type { HostServices, UsageRecord } from './ports.js';

export type ConformanceFinding = {
  readonly case: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type ConformanceReport = {
  readonly subject: string;
  readonly passed: boolean;
  readonly findings: readonly ConformanceFinding[];
};

export type HostConformanceOptions = {
  /**
   * A synthetic secret the kit resolves and then searches for in the store's serialization. When
   * absent, the serialization probes are skipped. A test must always use a synthetic value.
   */
  readonly syntheticSecret?: { readonly handle: string; readonly value: string };
};

const USAGE_RECORD_CONTENT_KEYS = ['prompt', 'output', 'text', 'messages', 'content', 'response', 'rawRequest', 'rawResponse'] as const;

function makeSyntheticUsageRecord(atMs: number): UsageRecord {
  return {
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    callerPluginId: 'conformance.caller',
    providerId: 'conformance-provider',
    modelClass: 'UNKNOWN',
    status: 'SUCCEEDED',
    latencyMs: 1,
    usage: {},
    atMs,
  };
}

async function caseIdentity(host: HostServices): Promise<ConformanceFinding> {
  const id = host.identity.currentCallerPluginId();
  const ok = id === null || CALLER_PLUGIN_ID_PATTERN.test(id);
  return {
    case: 'identity.null-or-host-bound',
    ok,
    detail: ok ? 'identity is null or a host-bound plugin id' : `identity "${String(id)}" is neither null nor a valid plugin id`,
  };
}

async function casePermissionsDenyByDefault(host: HostServices): Promise<ConformanceFinding> {
  const granted = host.permissions.isCapabilityGranted('conformance.caller', 'ai.bridge.conformance.absent');
  return {
    case: 'permissions.deny-by-default',
    ok: !granted,
    detail: granted ? 'an undeclared capability was granted' : 'an undeclared capability is denied',
  };
}

async function caseSubjectTokenOpaque(host: HostServices): Promise<ConformanceFinding> {
  const token = host.subjectTokens.mintSubjectToken();
  const ok = token === null || isOpaqueSubjectToken(token);
  return {
    case: 'subject-token.opaque-or-null',
    ok,
    detail: ok ? 'subject token is opaque or absent' : 'subject token is identity-shaped (an email, a JWT or a session token)',
  };
}

async function caseSecretsRedacted(host: HostServices, options: HostConformanceOptions): Promise<ConformanceFinding> {
  const missing = await host.secrets.resolve('secret://conformance/absent');
  if (missing !== null) {
    return { case: 'secrets.redacted', ok: false, detail: 'resolving an absent handle returned a value' };
  }
  const synthetic = options.syntheticSecret;
  if (synthetic === undefined) {
    return { case: 'secrets.redacted', ok: true, detail: 'absent handle resolved to null (no synthetic secret supplied)' };
  }
  const resolved = await host.secrets.resolve(synthetic.handle);
  if (resolved !== synthetic.value) {
    return { case: 'secrets.redacted', ok: true, detail: 'synthetic handle was not resolvable; serialization probe skipped' };
  }
  const serialized = `${JSON.stringify(host.secrets)}\n${String(host.secrets)}`;
  const leaked = serialized.includes(synthetic.value);
  return {
    case: 'secrets.redacted',
    ok: !leaked,
    detail: leaked ? 'the resolved secret appears in the store serialization' : 'the resolved secret never appears in the store serialization',
  };
}

async function caseUsageRoundTrip(host: HostServices, atMs: number): Promise<ConformanceFinding> {
  const record = makeSyntheticUsageRecord(atMs);
  await host.usage.append(record);
  const records = await host.usage.list();
  const found = records.some((entry) => entry.atMs === atMs && entry.capability === record.capability);
  return {
    case: 'usage.round-trip',
    ok: found,
    detail: found ? 'an appended usage record is readable' : 'an appended usage record was dropped',
  };
}

async function caseUsageNoContent(host: HostServices): Promise<ConformanceFinding> {
  const records = await host.usage.list();
  const offending = records.find((entry) =>
    USAGE_RECORD_CONTENT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(entry, key)),
  );
  if (offending === undefined) {
    return { case: 'usage.no-content', ok: true, detail: 'no usage record carries content fields' };
  }
  return { case: 'usage.no-content', ok: false, detail: 'a usage record carries a content-shaped field' };
}

async function caseKillSwitchValid(host: HostServices): Promise<ConformanceFinding> {
  const parsed = parseKillSwitchState(host.killSwitch.currentState());
  return {
    case: 'kill-switch.valid-state',
    ok: parsed.ok,
    detail: parsed.ok ? 'the kill-switch state parses' : 'the kill-switch state does not parse',
  };
}

async function caseClockFinite(host: HostServices): Promise<ConformanceFinding> {
  const now = host.clock.nowMs();
  const ok = Number.isFinite(now);
  return {
    case: 'clock.finite',
    ok,
    detail: ok ? 'the clock returns a finite epoch millisecond value' : 'the clock returned a non-finite value',
  };
}

async function caseConfigLoadable(host: HostServices): Promise<ConformanceFinding> {
  const config = await host.config.load();
  const ok = config !== undefined && config !== null;
  return {
    case: 'config.loadable',
    ok,
    detail: ok ? 'configuration loads' : 'configuration is undefined or null',
  };
}

/** Run every host-conformance case. Never throws: a thrown case is a failed finding. */
export async function runHostConformance(
  host: HostServices,
  options: HostConformanceOptions = {},
): Promise<ConformanceReport> {
  const atMs = Number.isFinite(host.clock.nowMs()) ? host.clock.nowMs() : 1_000_000;
  const cases: ReadonlyArray<readonly [string, () => Promise<ConformanceFinding>]> = [
    ['identity', () => caseIdentity(host)],
    ['permissions', () => casePermissionsDenyByDefault(host)],
    ['subject-token', () => caseSubjectTokenOpaque(host)],
    ['secrets', () => caseSecretsRedacted(host, options)],
    ['usage-round-trip', () => caseUsageRoundTrip(host, atMs)],
    ['usage-no-content', () => caseUsageNoContent(host)],
    ['kill-switch', () => caseKillSwitchValid(host)],
    ['clock', () => caseClockFinite(host)],
    ['config', () => caseConfigLoadable(host)],
  ];

  const findings: ConformanceFinding[] = [];
  for (const [name, run] of cases) {
    try {
      findings.push(await run());
    } catch (error) {
      findings.push({
        case: `${name}`,
        ok: false,
        detail: `the case threw: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  }

  return {
    subject: 'host',
    passed: findings.every((finding) => finding.ok),
    findings,
  };
}
