/**
 * Observability (ROADMAP Stage 5 Phase 44–47).
 *
 * Two channels, both safe by construction:
 *
 *  - **Metrics** — counters and distributions over a closed, **low-cardinality** label set. A
 *    metric label can never be a request id, a subject, a prompt, an email or provider prose
 *    (Phase 45): those turn a monitoring system into a data leak and a cost bomb.
 *  - **Operational events** — the eleven lifecycle events of Phase 47, with metadata-only
 *    payloads. An event may carry an id for correlation; it may never carry content.
 *
 * Both default to **no-op sinks**: no logging is the safest default (ARCHITECTURE.md §16.3).
 */

export const OPERATIONAL_EVENT_TYPES = [
  'ai.request_started',
  'ai.provider_attempt_started',
  'ai.provider_attempt_finished',
  'ai.fallback_applied',
  'ai.retry_applied',
  'ai.breaker_opened',
  'ai.rate_limited',
  'ai.quota_rejected',
  'ai.request_finished',
  'ai.config_reloaded',
  'ai.config_reload_failed',
] as const;

export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

/** The closed, metadata-only payload. Strings, finite numbers and booleans — never content. */
export type OperationalEventPayload = Readonly<Record<string, string | number | boolean>>;

export type OperationalEvent = {
  readonly type: OperationalEventType;
  readonly atMs: number;
  readonly payload: OperationalEventPayload;
};

export interface OperationalEventSink {
  emit(event: OperationalEvent): void;
}

/**
 * The closed metric label set (Phase 45). An unlisted label key is a bug, not a feature: there is
 * no free-form label channel in this interface at all.
 */
export const METRIC_LABEL_KEYS = [
  'capability',
  'providerId',
  'modelAlias',
  'modelClass',
  'status',
  'errorCode',
  'reason',
  'attemptKind',
  'failureClass',
  'dimension',
] as const;

export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];

export type MetricLabels = Readonly<Partial<Record<MetricLabelKey, string>>>;

export const METRIC_NAMES = [
  'ai.request.count',
  'ai.request.success.count',
  'ai.failure.count',
  'ai.attempt.count',
  'ai.fallback.count',
  'ai.retry.count',
  'ai.breaker_open.count',
  'ai.rate_limited.count',
  'ai.quota_rejected.count',
  'ai.latency.ms',
  'ai.tokens.total',
  'ai.cost.estimated',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export type MetricSample = {
  readonly name: MetricName;
  readonly value: number;
  readonly labels: MetricLabels;
};

export interface MetricsSink {
  record(sample: MetricSample): void;
}

export function nullOperationalEventSink(): OperationalEventSink {
  return { emit: () => undefined };
}

export function nullMetricsSink(): MetricsSink {
  return { record: () => undefined };
}

function labelKey(labels: MetricLabels): string {
  return METRIC_LABEL_KEYS.map((key) => `${key}=${labels[key] ?? ''}`).join('|');
}

/**
 * The in-memory metrics sink: grouped samples a test (or a future exporter) can read.
 * Counts are summed per label set; `latency.ms`, `tokens.total` and `cost.estimated` also keep
 * their samples so percentile work is possible later without a new contract.
 */
export class InMemoryMetrics implements MetricsSink {
  readonly #totals = new Map<string, { readonly name: MetricName; readonly labels: MetricLabels; total: number; count: number }>();

  record(sample: MetricSample): void {
    const key = `${sample.name}#${labelKey(sample.labels)}`;
    const existing = this.#totals.get(key);
    if (existing === undefined) {
      this.#totals.set(key, { name: sample.name, labels: sample.labels, total: sample.value, count: 1 });
      return;
    }
    existing.total += sample.value;
    existing.count += 1;
  }

  /** Totals per (name, labels). */
  totals(): readonly { readonly name: MetricName; readonly labels: MetricLabels; readonly total: number; readonly count: number }[] {
    return [...this.#totals.values()].map((entry) => ({ ...entry })).sort((a, b) => a.name.localeCompare(b.name) || labelKey(a.labels).localeCompare(labelKey(b.labels)));
  }

  total(name: MetricName, labels: MetricLabels = {}): number {
    return this.#totals.get(`${name}#${labelKey(labels)}`)?.total ?? 0;
  }

  sum(name: MetricName): number {
    let sum = 0;
    for (const entry of this.#totals.values()) {
      if (entry.name === name) {
        sum += entry.total;
      }
    }
    return sum;
  }
}

/** The in-memory event sink. Payloads are metadata only (Phase 47). */
export class RecordingOperationalEvents implements OperationalEventSink {
  readonly events: OperationalEvent[] = [];

  emit(event: OperationalEvent): void {
    this.events.push(event);
  }

  ofType(type: OperationalEventType): readonly OperationalEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}
