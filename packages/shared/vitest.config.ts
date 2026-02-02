import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    globals: true,
  },
  resolve: {
    // Ensure TypeScript source files are used, not compiled dist
    extensions: ['.ts', '.js'],
  },
});
