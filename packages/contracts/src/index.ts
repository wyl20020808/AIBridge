/**
 * `@aibridge/contracts` — the portable, dependency-free contract surface.
 *
 * Everything a consumer may see and everything a host must provide a call shape for lives here.
 * The package imports nothing outside itself, touches no platform global, and is safe to parse in
 * Node, a browser bundle, an edge worker or an embedded runtime (ARCHITECTURE.md §21).
 *
 * Errors are values, never throws: every parser returns a `ValidationResult`.
 */

// Version constants and the frozen major-compatibility policy.
export * from './versions.js';

// The closed error vocabulary and its classification tables.
export * from './errors.js';

// Validation issues and results.
export * from './issue.js';

// Capability identity, descriptors, availability and status.
export * from './capability.js';

// Model profiles and capability requirements.
export * from './profile.js';
export * from './requirements.js';

// The structured output schema dialect.
export * from './schema.js';

// Envelopes and their parts.
export * from './metadata.js';
export * from './warnings.js';
export * from './usage.js';
export * from './cancellation.js';
export * from './timeout.js';
export * from './request.js';
export * from './envelope.js';
export * from './context.js';
export * from './response.js';

// Provider and model descriptions, plus the provider adapter port.
export * from './provider.js';

// Governance.
export * from './killswitch.js';

// Structured extraction, validation and repair.
export * from './structured/extraction.js';
export * from './structured/validate.js';
export * from './structured/repair.js';
