/** Built-in capability descriptors. Registrations remain metadata-only. */
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

const CODE_DEBUG_INPUT_SCHEMA: OutputSchema = {
  kind: 'INLINE',
  schemaId: 'code.debug.analyze.input',
  version: '1.0',
  dialect: AIBRIDGE_FIELD_DIALECT,
  fields: [
    {
      name: 'instructions',
      type: 'STRING',
      required: true,
      description: 'Consumer-authored instructions for this diagnostic call.',
    },
    {
      name: 'context',
      type: 'OBJECT_ARRAY',
      required: true,
      description: 'Untrusted sourceCode and optional diagnostics values supplied by the caller.',
    },
  ],
};

/** Flat output shape; runtime validation further closes category and line-reference values. */
export const CODE_DEBUG_OUTPUT_SCHEMA: OutputSchema = {
  kind: 'INLINE',
  schemaId: 'code.debug.analyze.output',
  version: '1.0',
  dialect: AIBRIDGE_FIELD_DIALECT,
  fields: [
    {
      name: 'issueCategories',
      type: 'STRING_ARRAY',
      required: true,
      description: 'Closed categories: SYNTAX, TYPE, BUILD, RUNTIME, LOGIC, OTHER.',
    },
    {
      name: 'diagnosticContextRefs',
      type: 'STRING_ARRAY',
      required: true,
      description: 'One supplied-context line or range reference for each issue category.',
    },
    {
      name: 'limitations',
      type: 'STRING_ARRAY',
      required: true,
      description: 'Closed limitations: INSUFFICIENT_CONTEXT, AMBIGUOUS_EVIDENCE, NO_RELEVANT_LOCATION.',
    },
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

const CODE_DEBUG_POLICY: CapabilityPolicy = {
  id: 'code-debug-analyze-structural',
  version: '1.0',
  inputAllowList: ['instructions', 'context'],
  outputRules: ['SCHEMA_CONFORMANCE', 'NO_UNKNOWN_FIELDS', 'SIZE_WITHIN_LIMIT'],
  forbiddenOutput: [],
  maxOutputBytes: 16_384,
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

export const CODE_DEBUG_CAPABILITY_REGISTRATION: CapabilityRegistration = {
  id: 'code.debug.analyze',
  version: '1.0',
  kind: 'SPECIALIZED',
  requiredPrimitive: 'ai.structured.generate',
  inputSchema: CODE_DEBUG_INPUT_SCHEMA,
  outputSchema: CODE_DEBUG_OUTPUT_SCHEMA,
  policy: CODE_DEBUG_POLICY,
  profiles: [...MODEL_PROFILES],
  requirements: structuredGenerationRequirements(),
  limits: { maxInputBytes: 32_768, maxOutputBytes: 16_384, totalTimeoutMs: 20_000, maxCallsPerTurn: 1 },
  allowGenericFallback: false,
  retention: 'METADATA_ONLY',
  schemaOwnership: { input: 'REGISTRY', output: 'REGISTRY', policy: 'REGISTRY' },
  status: 'AVAILABLE',
  readiness: 'STABLE',
  instructionMode: 'CONSUMER_COMPOSED',
};

/** Static built-ins registered by the default runtime; the generic list remains generic-only. */
export const BUILTIN_CAPABILITY_REGISTRATIONS: readonly CapabilityRegistration[] = [
  ...GENERIC_CAPABILITY_REGISTRATIONS,
  CODE_DEBUG_CAPABILITY_REGISTRATION,
];

/** True when the capability lets the caller author its output schema. */
export function allowsCallerOutputSchema(schemaOwnership: { readonly output: string }): boolean {
  return schemaOwnership.output === 'CALLER';
}
