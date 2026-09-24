/** Static boundary validation for the registry-owned `code.debug.analyze@1.0` contract. */
import {
  INSTRUCTIONS_MAX_LENGTH,
  at,
  createIssue,
  invalid,
  parseStructuredGenerateInput,
  valid,
  type StructuredGenerateInput,
  type ValidationIssue,
  type ValidationResult,
} from '@aibridge/contracts';
import { isRecord, utf8ByteLength } from '@aibridge/core';

export const CODE_DEBUG_MAX_INPUT_BYTES = 32_768;
export const CODE_DEBUG_MAX_FINDINGS = 64;
export const CODE_DEBUG_MAX_LIMITATIONS = 3;

export const CODE_DEBUG_ISSUE_CATEGORIES = ['SYNTAX', 'TYPE', 'BUILD', 'RUNTIME', 'LOGIC', 'OTHER'] as const;
export const CODE_DEBUG_LIMITATIONS = ['INSUFFICIENT_CONTEXT', 'AMBIGUOUS_EVIDENCE', 'NO_RELEVANT_LOCATION'] as const;

const CODE_DEBUG_CONTEXT_NAMES = new Set(['sourceCode', 'diagnostics']);
const CODE_DEBUG_OUTPUT_FIELDS = ['issueCategories', 'diagnosticContextRefs', 'limitations'] as const;
const CODE_DEBUG_REFERENCE_PATTERN = /^(sourceCode|diagnostics):([1-9][0-9]*)(?:-([1-9][0-9]*))?$/;

/** Parse the specialized input while retaining the trusted instruction and untrusted data channels. */
export function parseCodeDebugInput(value: unknown, path = '$'): ValidationResult<StructuredGenerateInput> {
  const parsed = parseStructuredGenerateInput(value, path);
  if (!parsed.ok) {
    return parsed;
  }

  const issues: ValidationIssue[] = [];
  let sourceCodeCount = 0;
  for (const [index, context] of parsed.value.context.entries()) {
    const contextPath = at(at(path, 'context'), index);
    if (!CODE_DEBUG_CONTEXT_NAMES.has(context.name)) {
      issues.push(createIssue('UNKNOWN_FIELD', at(contextPath, 'name'), 'context name is not permitted'));
      continue;
    }
    if (context.name === 'sourceCode') {
      sourceCodeCount += 1;
    }
    if (context.type !== 'STRING') {
      issues.push(createIssue('INVALID_TYPE', at(contextPath, 'type'), 'must be STRING'));
    }
    if (!context.untrusted) {
      issues.push(createIssue('TRUSTED_FIELD', at(contextPath, 'untrusted'), 'specialized context values must be untrusted'));
    }
  }
  if (sourceCodeCount !== 1) {
    issues.push(createIssue('MISSING_FIELD', at(path, 'context'), 'must contain exactly one sourceCode value'));
  }

  const serialized = JSON.stringify(parsed.value);
  if (serialized === undefined || utf8ByteLength(serialized) > CODE_DEBUG_MAX_INPUT_BYTES) {
    issues.push(createIssue('SIZE_EXCEEDED', path, `must be at most ${CODE_DEBUG_MAX_INPUT_BYTES} UTF-8 bytes`));
  }
  if (parsed.value.instructions.length > INSTRUCTIONS_MAX_LENGTH) {
    // Kept explicit for callers using this parser independently of the generic parser.
    issues.push(createIssue('OUT_OF_RANGE', at(path, 'instructions'), `must be at most ${INSTRUCTIONS_MAX_LENGTH} characters`));
  }

  return issues.length > 0 ? invalid('MALFORMED_ENVELOPE', issues) : valid(parsed.value);
}

/** Validate the flat diagnostic result and ensure every reference points into supplied context. */
export function validateCodeDebugOutput(
  value: unknown,
  input: StructuredGenerateInput,
  path = '$',
): ValidationResult<unknown> {
  if (!isRecord(value)) {
    return invalid('SCHEMA_VALIDATION_FAILED', [createIssue('INVALID_TYPE', path, 'must be an object')]);
  }

  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!(CODE_DEBUG_OUTPUT_FIELDS as readonly string[]).includes(key)) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown diagnostic output field'));
    }
  }

  const issueCategories = value['issueCategories'];
  const diagnosticContextRefs = value['diagnosticContextRefs'];
  const limitations = value['limitations'];
  for (const [field, fieldValue] of [
    ['issueCategories', issueCategories],
    ['diagnosticContextRefs', diagnosticContextRefs],
    ['limitations', limitations],
  ] as const) {
    if (fieldValue === undefined) {
      issues.push(createIssue('MISSING_FIELD', at(path, field), 'required field is missing'));
    } else if (!Array.isArray(fieldValue) || !fieldValue.every((entry) => typeof entry === 'string')) {
      issues.push(createIssue('INVALID_TYPE', at(path, field), 'must be an array of strings'));
    }
  }

  const categories = Array.isArray(issueCategories) && issueCategories.every((entry) => typeof entry === 'string')
    ? issueCategories as string[]
    : [];
  const references = Array.isArray(diagnosticContextRefs) && diagnosticContextRefs.every((entry) => typeof entry === 'string')
    ? diagnosticContextRefs as string[]
    : [];
  const limitationValues = Array.isArray(limitations) && limitations.every((entry) => typeof entry === 'string')
    ? limitations as string[]
    : [];

  if (categories.length > CODE_DEBUG_MAX_FINDINGS || references.length > CODE_DEBUG_MAX_FINDINGS) {
    issues.push(createIssue('SIZE_EXCEEDED', at(path, 'issueCategories'), `must contain at most ${CODE_DEBUG_MAX_FINDINGS} findings`));
  }
  if (limitationValues.length > CODE_DEBUG_MAX_LIMITATIONS) {
    issues.push(createIssue('SIZE_EXCEEDED', at(path, 'limitations'), `must contain at most ${CODE_DEBUG_MAX_LIMITATIONS} limitations`));
  }
  if (categories.length !== references.length) {
    issues.push(createIssue('INVARIANT_VIOLATION', at(path, 'diagnosticContextRefs'), 'each issue category must have one context reference'));
  }

  const contextLineCounts = new Map<string, number>();
  for (const context of input.context) {
    if (CODE_DEBUG_CONTEXT_NAMES.has(context.name) && typeof context.value === 'string') {
      contextLineCounts.set(context.name, context.value.split(/\r\n|\n|\r/).length);
    }
  }

  categories.forEach((category, index) => {
    if (!(CODE_DEBUG_ISSUE_CATEGORIES as readonly string[]).includes(category)) {
      issues.push(createIssue('INVALID_VALUE', at(at(path, 'issueCategories'), index), 'category is not permitted'));
    }
  });
  references.forEach((reference, index) => {
    const referencePath = at(at(path, 'diagnosticContextRefs'), index);
    const match = CODE_DEBUG_REFERENCE_PATTERN.exec(reference);
    if (match === null) {
      issues.push(createIssue('PATTERN_MISMATCH', referencePath, 'must be a supplied context line or range reference'));
      return;
    }
    const contextName = match[1] as string;
    const startLine = Number(match[2]);
    const endLine = match[3] === undefined ? startLine : Number(match[3]);
    const lineCount = contextLineCounts.get(contextName);
    if (lineCount === undefined || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) {
      issues.push(createIssue('INVALID_VALUE', referencePath, 'must reference a supplied context'));
      return;
    }
    if (startLine > endLine || endLine > lineCount) {
      issues.push(createIssue('OUT_OF_RANGE', referencePath, 'line range is outside the supplied context'));
    }
  });
  limitationValues.forEach((limitation, index) => {
    if (!(CODE_DEBUG_LIMITATIONS as readonly string[]).includes(limitation)) {
      issues.push(createIssue('INVALID_VALUE', at(at(path, 'limitations'), index), 'limitation is not permitted'));
    }
  });

  if (issues.length > 0) {
    return invalid('SCHEMA_VALIDATION_FAILED', issues);
  }
  return valid({
    issueCategories: [...categories],
    diagnosticContextRefs: [...references],
    limitations: [...limitationValues],
  });
}
