import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'data/**', 'spec/neon-api-v2.json'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { sourceType: 'module' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', crypto: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly', Buffer: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
);
