/**
 * The delay seam (ROADMAP Stage 5 — backoff, Retry-After).
 *
 * Backoff must be **deterministic and testable**: no test ever sleeps real seconds, so every wait
 * in the reliability layer goes through a `Sleeper`. Tests inject `instantSleeper`, which advances
 * a fake clock instead of time itself.
 */
import type { CancellationToken } from '@aibridge/contracts';

export const SLEEP_OUTCOMES = ['ELAPSED', 'CANCELLED'] as const;

export type SleepOutcome = (typeof SLEEP_OUTCOMES)[number];

export interface Sleeper {
  /** Wait `ms`, or return early when the caller cancels. Never rejects. */
  sleep(ms: number, cancellation?: CancellationToken): Promise<SleepOutcome>;
}

/** The production sleeper. The only place the reliability layer touches real time. */
export function systemSleeper(): Sleeper {
  return {
    sleep(ms: number, cancellation?: CancellationToken): Promise<SleepOutcome> {
      return new Promise<SleepOutcome>((resolve) => {
        if (cancellation?.cancelled === true) {
          resolve('CANCELLED');
          return;
        }
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        const settle = (outcome: SleepOutcome): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (unsubscribe !== undefined) {
            unsubscribe();
          }
          resolve(outcome);
        };
        const timer = setTimeout(() => settle('ELAPSED'), Math.max(0, ms));
        if (cancellation !== undefined) {
          unsubscribe = cancellation.onCancel(() => settle('CANCELLED'));
        }
      });
    },
  };
}

/**
 * The test sleeper: it advances a clock (a `TestClock`, structurally) and returns immediately.
 * `advance` is optional so a frozen clock can be used when only determinism matters.
 */
export function instantSleeper(advance?: (ms: number) => void): Sleeper {
  return {
    sleep(ms: number, cancellation?: CancellationToken): Promise<SleepOutcome> {
      if (cancellation?.cancelled === true) {
        return Promise.resolve('CANCELLED' as const);
      }
      advance?.(ms);
      return Promise.resolve('ELAPSED' as const);
    },
  };
}
