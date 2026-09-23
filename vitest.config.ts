import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePackage = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests resolve `@aibridge/*` to source, so `vitest run` needs no build step. The published
 * packages resolve through their built `dist/`; the aliases exist only for the test process.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@aibridge/contracts': resolvePackage('./packages/contracts/src/index.ts'),
      '@aibridge/core': resolvePackage('./packages/core/src/index.ts'),
      '@aibridge/host-sdk': resolvePackage('./packages/host-sdk/src/index.ts'),
      '@aibridge/governance': resolvePackage('./packages/governance/src/index.ts'),
      '@aibridge/runtime': resolvePackage('./packages/runtime/src/index.ts'),
      '@aibridge/provider-openai-compatible': resolvePackage('./packages/provider-openai-compatible/src/index.ts'),
      '@aibridge/provider-openai': resolvePackage('./packages/provider-openai/src/index.ts'),
      '@aibridge/provider-deepseek': resolvePackage('./packages/provider-deepseek/src/index.ts'),
      '@aibridge/provider-xiaomi-tokenplan': resolvePackage('./packages/provider-xiaomi-tokenplan/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
