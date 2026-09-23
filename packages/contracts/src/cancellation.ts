/**
 * A host-neutral cancellation token (ARCHITECTURE.md §4.5, §13).
 *
 * Deliberately **not** `AbortSignal` and not `AbortController`: no DOM type may appear in a
 * contract. A host adapter may wrap one around this.
 */
export interface CancellationToken {
  readonly cancelled: boolean;
  /** Subscribe to cancellation. Returns an unsubscribe function. */
  readonly onCancel: (callback: () => void) => () => void;
}

/** A token that is never cancelled. The honest default when a host offers no cancellation. */
export function neverCancelled(): CancellationToken {
  return {
    cancelled: false,
    onCancel: () => () => {
      // no-op unsubscribe
    },
  };
}

/** A token that is already cancelled. */
export function alreadyCancelled(): CancellationToken {
  return {
    cancelled: true,
    onCancel: (callback) => {
      callback();
      return () => {
        // no-op unsubscribe
      };
    },
  };
}
