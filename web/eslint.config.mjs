// Lint config for the site's code (npm run lint).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-shadow': 'error',
      'prefer-const': 'error',
    },
  },
  { files: ['test/**', 'build.mjs', 'serve.mjs', 'tools/**'], languageOptions: { globals: { ...globals.node } } },
];
