/**
 * Live-failure classification (Stage 8, Phases 21-25, 44, 45).
 *
 * A live failure must be classified into a small, stable vocabulary so the operator knows whether to
 * fix configuration, replace a credential, wait out a provider, or file an AI Bridge bug — without
 * the provider's raw prose ever entering a record (AGENTS.md §4).
 *
 * This module is deterministic and dependency-free. Providers adapt their own transport shapes into
 * {@link FailureSignal} here; the mapping itself never varies by vendor wording.
 */

import type { QualificationFailureClass } from './status.js';

/**
 * A normalized failure signal. Providers map their own error shapes onto this; the classifier only
 * ever sees these coarse categories, never a message.
 */
export type FailureSignal =
  | { readonly kind: 'auth' }
  | { readonly kind: 'balance' }
  | { readonly kind: 'throttled' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable'; readonly status?: number }
  | { readonly kind: 'bad-response' }
  | { readonly kind: 'capability-mismatch' }
  | { readonly kind: 'config' }
  | { readonly kind: 'network' }
  | { readonly kind: 'unknown' };

/**
 * Classify a normalized signal. The output is drawn from {@link QUALIFICATION_FAILURE_CLASSES} only.
 */
export function classifyQualificationFailure(signal: FailureSignal): QualificationFailureClass {
  switch (signal.kind) {
    case 'auth':
    case 'balance':
    case 'config':
      return 'CONFIG_FAILURE';
    case 'capability-mismatch':
      return 'CAPABILITY_MISMATCH';
    case 'bad-response':
      return 'ADAPTER_BUG';
    case 'network':
      return 'NETWORK_ENVIRONMENT';
    case 'throttled':
    case 'timeout':
    case 'unavailable':
    case 'unknown':
      return 'PROVIDER_FAILURE';
    default:
      return 'PROVIDER_FAILURE';
  }
}

/** True when a classification indicates a defect AI Bridge may fix (Phase 44/46). */
export function isFixableInAIBridge(failureClass: QualificationFailureClass): boolean {
  return failureClass === 'ADAPTER_BUG';
}
