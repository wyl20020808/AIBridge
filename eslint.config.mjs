/**
 * ESLint flat config (ROADMAP Stage 3 — pays down the Stage 2 deferral).
 *
 * Deliberately small: the strict TypeScript compiler already owns type-level correctness, the
 * coupling gate owns host neutrality and the secret gate owns credential shapes. ESLint is here to
 * catch the residual class of mistakes those three miss — dead code, accidental globals, unsafe
 * patterns — and **not** to reformat the repository. Style is not renegotiated here.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'tmp/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // `tsc` owns name resolution for types and platform globals; eslint sees no type information.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
