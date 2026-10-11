import { defineConfig } from 'eslint/config';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// UI files that still call fetch directly. The list only shrinks: migrate a file to
// apiFetch and delete its line; never add one.
const LEGACY_BARE_FETCH_FILES = [];

const UI_TEST_FILES = ['src/ui/**/*.spec.{ts,tsx}', 'src/ui/**/*.test.{ts,tsx}'];

const BARE_FETCH_MESSAGE =
  'Use apiFetch/useFetchFactory from src/ui/lib/api-transport.ts so the request reaches the right backend.';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'test/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended, prettierRecommended],
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      'no-loss-of-precision': 'error',
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: UI_TEST_FILES,
    rules: { 'react-hooks/exhaustive-deps': 'off' },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: ['src/ui/lib/api-transport.ts', ...UI_TEST_FILES, ...LEGACY_BARE_FETCH_FILES],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: BARE_FETCH_MESSAGE }],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'fetch', message: BARE_FETCH_MESSAGE },
        { object: 'globalThis', property: 'fetch', message: BARE_FETCH_MESSAGE },
        { object: 'self', property: 'fetch', message: BARE_FETCH_MESSAGE },
      ],
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: UI_TEST_FILES,
    rules: {
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },
);
