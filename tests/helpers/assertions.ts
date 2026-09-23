import type { ValidationFailure, ValidationResult } from '@aibridge/contracts';

/** Assert a result is `ok` and return its value, with a useful failure message. */
export function unwrap<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected a valid result, got ${result.failure.reason}: ${JSON.stringify(result.failure.issues)}`,
    );
  }
  return result.value;
}

/** Assert a result is a failure and return the failure, with a useful message. */
export function unwrapFailure<T>(result: ValidationResult<T>): ValidationFailure {
  if (result.ok) {
    throw new Error('expected an invalid result, got a value');
  }
  return result.failure;
}
