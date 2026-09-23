/**
 * Identifier minting for logical requests and provider attempts.
 *
 * Deterministic by construction: a mint is a counter, so a test can reason about identity without
 * a UUID implementation or a randomness seam. Uniqueness across processes is the host's job (the
 * logical request id is derived from the consumer's `requestId`, which is already unique per call).
 */
export type IdMint = {
  /** `prefix` + a monotonic counter, e.g. `att-3`. */
  next(prefix: string): string;
  /** How many ids have been minted. */
  readonly issued: number;
};

export function createIdMint(startAt = 0): IdMint {
  let counter = startAt;
  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
    get issued(): number {
      return counter - startAt;
    },
  };
}
