/**
 * Built-in generic capability descriptors (CAPABILITIES.md §1.1).
 *
 * Exactly two primitives ship in V1, and both are registered here as **metadata**. There is no
 * handler and no execution: Stage 2 defines what the primitives promise, not how they run.
 *
 * Structural safety only. Neither policy carries a business rule — that is how
 * `ai.structured.generate` stays reusable instead of growing one product's rules.
 */
import {
  AIBRIDGE_FIELD_DIALECT,
  MODEL_PROFILES,
  structuredGenerationRequirements,
  textGenerationRequirements,
  type CapabilityPolicy,
  type OutputSchema,
} from '@aibridge/contracts';
import type { CapabilityRegistration } from './registry.js';

/** The caller-owned output placeholder. Resolved from the request's `outputSchema`. */
export const CALLER_OWNED_OUTPUT_SCHEMA: OutputSchema = {
  kind: 'REF',
  ref: { schemaId: 'ai.structured.generate.output', version: '1.0' },
};

const GENERIC_INPUT_SCHEMA: OutputSchema = {
  kind: 'INLINE',
  schemaId: 'ai.generic.input',
  version: '1.0',
  dialect: AIBRIDGE_FIELD_DIALECT,
  fields: [
    {
      name: 'instructions',
      type: 'STRING',
      required: true,
      description: 'The authored instruction channel, versioned by the caller.',
    },
    {
      name: 'context',
      type: 'OBJECT_ARRAY',
      required: true,
      description: 'Labelled runtime values. Each untrusted value is rendered as delimited data.',
    },
  ],
};

const TEXT_OUTPUT_SCHEMA: OutputSchema = {
  kind: 'INLINE',
  schemaId: 'ai.text.generate.output',
  version: '1.0',
  dialect: AIBRIDGE_FIELD_DIALECT,
  fields: [
    { name: 'text', type: 'STRING', required: true, description: 'The generated text.' },
    { name: 'finishReason', type: 'STRING', required: true, description: 'Why generation stopped.' },
  ],
};

/** `ai.text.generate`'s policy: structural safety only, no business claim. */
export const GENERIC_TEXT_POLICY: CapabilityPolicy = {
  id: 'ai-text-default',
  version: '1.0',
  inputAllowList: ['instructions', 'context', 'maxOutputTokens'],
  outputRules: ['SIZE_WITHIN_LIMIT'],
  forbiddenOutput: [],
  maxOutputBytes: 32_768,
};

/** `ai.structured.generate`'s policy: structural safety only, no business claim. */
export const GENERIC_STRUCTURED_POLICY: CapabilityPolicy = {
  id: 'ai-structured-default',
  version: '1.0',
  inputAllowList: ['instructions', 'context'],
  outputRules: ['SCHEMA_CONFORMANCE', 'NO_UNKNOWN_FIELDS', 'SIZE_WITHIN_LIMIT'],
  forbiddenOutput: [],
  maxOutputBytes: 65_536,
};

/**
 * The V1 generic primitives.
 *
 * `schemaOwnership.output` is the load-bearing difference: a structured request may carry a
 * caller-authored `outputSchema`; a text request may not, and the registry owns the shape.
 */
export const GENERIC_CAPABILITY_REGISTRATIONS: readonly CapabilityRegistration[] = [
  {
    id: 'ai.text.generate',
    version: '1.0',
    kind: 'GENERIC',
    requiredPrimitive: 'ai.text.generate',
    inputSchema: GENERIC_INPUT_SCHEMA,
    outputSchema: TEXT_OUTPUT_SCHEMA,
    policy: GENERIC_TEXT_POLICY,
    profiles: [...MODEL_PROFILES],
    requirements: textGenerationRequirements(),
    limits: { maxInputBytes: 32_768, maxOutputBytes: 32_768, totalTimeoutMs: 20_000, maxCallsPerTurn: 1 },
    allowGenericFallback: true,
    retention: 'METADATA_ONLY',
    schemaOwnership: { input: 'REGISTRY', output: 'REGISTRY', policy: 'REGISTRY' },
    status: 'AVAILABLE',
  },
  {
    id: 'ai.structured.generate',
    version: '1.0',
    kind: 'GENERIC',
    requiredPrimitive: 'ai.structured.generate',
    inputSchema: GENERIC_INPUT_SCHEMA,
    outputSchema: CALLER_OWNED_OUTPUT_SCHEMA,
    policy: GENERIC_STRUCTURED_POLICY,
    profiles: [...MODEL_PROFILES],
    requirements: structuredGenerationRequirements(),
    limits: { maxInputBytes: 32_768, maxOutputBytes: 65_536, totalTimeoutMs: 20_000, maxCallsPerTurn: 1 },
    allowGenericFallback: true,
    retention: 'METADATA_ONLY',
    schemaOwnership: { input: 'REGISTRY', output: 'CALLER', policy: 'REGISTRY' },
    status: 'AVAILABLE',
  },
];

/** True when the capability lets the caller author its output schema. */
export function allowsCallerOutputSchema(schemaOwnership: { readonly output: string }): boolean {
  return schemaOwnership.output === 'CALLER';
}
