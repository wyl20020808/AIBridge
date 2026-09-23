/**
 * Provider and model registries (ARCHITECTURE.md §7, ROADMAP Stage 2).
 *
 * Stage 2 registers **descriptions**, never adapters. No provider is implemented, no vendor SDK is
 * imported, no network call exists. Feature support is a property of the *model*: two models behind
 * one provider frequently differ (ARCHITECTURE.md §7).
 */
import {
  createIssue,
  invalid,
  isModelProfile,
  isProviderFamily,
  valid,
  type ModelDescriptor,
  type ModelProfile,
  type ProviderDescriptor,
  type ValidationIssue,
  type ValidationResult,
} from '@aibridge/contracts';
import { canonicalize, isPositiveInteger } from './util.js';

function validateProvider(descriptor: ProviderDescriptor): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
    issues.push(createIssue('INVALID_TYPE', '$.id', 'must be a non-empty provider id'));
  }
  if (!isProviderFamily(descriptor.family)) {
    issues.push(createIssue('INVALID_VALUE', '$.family', 'must be a known provider family'));
  }
  if (!isPositiveInteger(descriptor.maxConcurrency)) {
    issues.push(createIssue('INVALID_TYPE', '$.maxConcurrency', 'must be a positive integer'));
  }
  if (typeof descriptor.supportsIdempotency !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', '$.supportsIdempotency', 'must be a boolean'));
  }
  return issues;
}

function validateModel(model: ModelDescriptor): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of ['providerId', 'modelRef', 'displayName'] as const) {
    if (typeof model[key] !== 'string' || model[key].length === 0) {
      issues.push(createIssue('INVALID_TYPE', `$.${key}`, 'must be a non-empty string'));
    }
  }
  for (const key of ['maxContextTokens', 'maxOutputTokens'] as const) {
    if (!isPositiveInteger(model[key])) {
      issues.push(createIssue('INVALID_TYPE', `$.${key}`, 'must be a positive integer'));
    }
  }
  if (!model.profiles.every((profile) => isModelProfile(profile))) {
    issues.push(createIssue('INVALID_VALUE', '$.profiles', 'must contain only known profiles'));
  }
  return issues;
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDescriptor>();

  register(descriptor: ProviderDescriptor): ValidationResult<ProviderDescriptor> {
    const issues = validateProvider(descriptor);
    if (issues.length > 0) {
      return invalid('MALFORMED_ENVELOPE', issues);
    }
    const existing = this.#providers.get(descriptor.id);
    if (existing !== undefined) {
      if (canonicalize(existing) === canonicalize(descriptor)) {
        return valid(existing);
      }
      return invalid('MALFORMED_ENVELOPE', [
        createIssue('CONFLICTING_REGISTRATION', '$', `a different descriptor already exists for provider "${descriptor.id}"`),
      ]);
    }
    this.#providers.set(descriptor.id, descriptor);
    return valid(descriptor);
  }

  get(id: string): ProviderDescriptor | null {
    return this.#providers.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): readonly ProviderDescriptor[] {
    return [...this.#providers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  remove(id: string): boolean {
    return this.#providers.delete(id);
  }

  get size(): number {
    return this.#providers.size;
  }

  clear(): void {
    this.#providers.clear();
  }
}

/** Model descriptors keyed by `providerId` + `modelRef`. Operator-side only. */
export class ModelRegistry {
  readonly #models = new Map<string, ModelDescriptor>();

  #key(providerId: string, modelRef: string): string {
    return `${providerId}\u0000${modelRef}`;
  }

  register(model: ModelDescriptor): ValidationResult<ModelDescriptor> {
    const issues = validateModel(model);
    if (issues.length > 0) {
      return invalid('MALFORMED_ENVELOPE', issues);
    }
    const key = this.#key(model.providerId, model.modelRef);
    const existing = this.#models.get(key);
    if (existing !== undefined) {
      if (canonicalize(existing) === canonicalize(model)) {
        return valid(existing);
      }
      return invalid('MALFORMED_ENVELOPE', [
        createIssue('CONFLICTING_REGISTRATION', '$', `a different descriptor already exists for ${model.providerId}/${model.modelRef}`),
      ]);
    }
    this.#models.set(key, model);
    return valid(model);
  }

  get(providerId: string, modelRef: string): ModelDescriptor | null {
    return this.#models.get(this.#key(providerId, modelRef)) ?? null;
  }

  list(): readonly ModelDescriptor[] {
    return [...this.#models.values()];
  }

  listByProvider(providerId: string): readonly ModelDescriptor[] {
    return this.list().filter((model) => model.providerId === providerId);
  }

  findByProfile(profile: ModelProfile): readonly ModelDescriptor[] {
    return this.list().filter((model) => model.profiles.includes(profile));
  }

  get size(): number {
    return this.#models.size;
  }

  clear(): void {
    this.#models.clear();
  }
}
