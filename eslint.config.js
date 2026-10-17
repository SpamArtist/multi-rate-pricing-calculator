import eslint from '@eslint/js';
import css from '@eslint/css';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import cssMaxLines from './scripts/css-max-lines-rule.js';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.local/**', 'prototype/**', 'drizzle/**', 'test-results/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
  },
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['src/**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'max-lines': ['error', 1000],
    },
  },
  {
    files: ['src/server/http/**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'drizzle-orm', message: 'Call a use-case module; keep queries in persistence functions.' },
          { name: 'pg', message: 'Call a use-case module; keep DB access in persistence functions.' },
        ],
        patterns: [{
          group: ['drizzle-orm/*', '../../db/*', '**/db/*'],
          message: 'HTTP adapters must not import DB modules or query helpers.',
        }],
      }],
    },
  },
  {
    files: ['src/**/*.css'],
    language: 'css/css',
    plugins: { css, local: { rules: { 'css-max-lines': cssMaxLines } } },
    rules: {
      'local/css-max-lines': ['error', 1000],
    },
  },
);
