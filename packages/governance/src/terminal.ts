/**
 * Terminal error selection (ROADMAP Stage 5 Phase 55).
 *
 * When every candidate has failed, the caller gets **one** stable terminal error. Choosing it is a
 * policy, not an accident: "turn everything into `INTERNAL`" (Phase 55) would hide the only fact a
 * consumer can act on.
 *
 * The policy, highest priority first:
 *
 *  1. **Cancellation** — somebody stopped the call; that is always the truth.
 *  2. **Request / content / permission** — the root cause that would fail everywhere. The earliest
 *     such failure wins, because it is the reason the turn could never have succeeded.
 *  3. **Deadline** — the caller's own budget ran out; the last provider error would mislead.
 *  4. **Governance** — our own limit refused; the most recent one wins.
 *  5. **The last attempt's error** — the freshest evidence about the provider world.
 *  6. **The supplied fallback error** — when nothing was ever dispatched (`NO_ROUTE` and friends).
 */
import type { AiError } from '@aibridge/contracts';
import { classifyFailure, type FailureClass } from './failure-class.js';

export type TerminalCandidate = {
  readonly error: AiError;
  /** Attempt sequence; earlier is earlier. */
  readonly sequence: number;
};

const CLASS_PRIORITY: readonly FailureClass[] = ['CANCELLED', 'REQUEST', 'CONTENT', 'PERMISSION', 'DEADLINE', 'GOVERNANCE'];

export type TerminalSelectionInput = {
  readonly candidates: readonly TerminalCandidate[];
  /** Used only when no attempt produced an error (nothing was dispatched). */
  readonly fallbackError: AiError;
  /** The overall budget elapsed while deciding (Phase 7). Overrides provider evidence. */
  readonly deadlineExhausted?: boolean;
};

export function selectTerminalError(input: TerminalSelectionInput): AiError {
  const ordered = [...input.candidates].sort((a, b) => a.sequence - b.sequence);
  for (const failureClass of CLASS_PRIORITY) {
    if (failureClass === 'GOVERNANCE') {
      // Our own limit refused — the most recent refusal is the operative one.
      const lastMatch = [...ordered].reverse().find((candidate) => classifyFailure(candidate.error) === failureClass);
      if (lastMatch !== undefined) {
        return lastMatch.error;
      }
      continue;
    }
    const match = ordered.find((candidate) => classifyFailure(candidate.error) === failureClass);
    if (match !== undefined) {
      return match.error;
    }
  }
  if (input.deadlineExhausted === true) {
    return input.fallbackError;
  }
  const last = ordered[ordered.length - 1];
  return last === undefined ? input.fallbackError : last.error;
}
