/**
 * Structured extraction (ARCHITECTURE.md §11.4, INTEGRATION_CONTRACT_V1.md §5.2).
 *
 * The claim "this is JSON" is a **hint**, not evidence. Ordered extraction, first match wins:
 *
 *  1. a fenced ` ```json … ``` ` block;
 *  2. the outermost balanced `{ … }` or `[ … ]` span;
 *  3. plain JSON;
 *  4. otherwise `EXTRACTION_FAILED`.
 *
 * This is **pure extraction**. It never calls a model to "fix" a payload, and it never invents
 * structure. A fenced block that does not parse is `JSON_PARSE_FAILED`, not a silent retry of the
 * next strategy — a model that wrote broken JSON in a fence wrote broken JSON.
 */
import type { ValidationResult } from '../issue.js';
import { createIssue, invalid, valid } from '../issue.js';

export const EXTRACTION_STRATEGIES = ['FENCED_JSON', 'BALANCED_SPAN', 'PLAIN_JSON'] as const;

export type ExtractionStrategy = (typeof EXTRACTION_STRATEGIES)[number];

export type ExtractedCandidate = {
  readonly strategy: ExtractionStrategy;
  /** The exact substring that was parsed. */
  readonly text: string;
  readonly parsed: unknown;
};

const FENCED = /```(?:[ \t]*json[ \t]*)?\r?\n?([\s\S]*?)```/i;

function tryParse(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Find the outermost balanced `{ … }` or `[ … ]` span.
 *
 * String-aware: braces inside JSON strings do not affect the depth, and escapes are honoured.
 * Returns the first balanced span, or `null`.
 */
export function findBalancedSpan(text: string): string | null {
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{' || char === '[') {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opening) {
      depth += 1;
      continue;
    }
    if (char === closing || (opening === '{' && char === ']') || (opening === '[' && char === '}')) {
      // Only the matching close type decrements when we are at depth; a mismatched close means the
      // span is not balanced JSON and we keep scanning for a later, valid span.
      if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      } else {
        return null;
      }
    }
  }
  return null;
}

/** Extract and parse the first structured candidate from a raw provider payload. */
export function extractStructuredCandidate(raw: string): ValidationResult<ExtractedCandidate> {
  const fence = FENCED.exec(raw);
  if (fence !== null && typeof fence[1] === 'string') {
    const text = fence[1].trim();
    const parsed = tryParse(text);
    if (!parsed.ok) {
      return invalid('JSON_PARSE_FAILED', [
        createIssue('JSON_PARSE_FAILED', '$', 'the fenced JSON block did not parse'),
      ]);
    }
    return valid({ strategy: 'FENCED_JSON', text, parsed: parsed.value });
  }

  const span = findBalancedSpan(raw);
  if (span !== null) {
    const parsed = tryParse(span);
    if (!parsed.ok) {
      return invalid('JSON_PARSE_FAILED', [
        createIssue('JSON_PARSE_FAILED', '$', 'the outermost balanced span did not parse'),
      ]);
    }
    return valid({ strategy: 'BALANCED_SPAN', text: span, parsed: parsed.value });
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParse(trimmed);
    if (!parsed.ok) {
      return invalid('JSON_PARSE_FAILED', [
        createIssue('JSON_PARSE_FAILED', '$', 'the payload did not parse as JSON'),
      ]);
    }
    return valid({ strategy: 'PLAIN_JSON', text: trimmed, parsed: parsed.value });
  }

  return invalid('EXTRACTION_FAILED', [
    createIssue('EXTRACTION_FAILED', '$', 'no fenced JSON block, balanced span or plain JSON object was found'),
  ]);
}
