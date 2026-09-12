import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // `@quotalens/shared` is a workspace symlink to ../shared/schema.ts — TS source, not a build
    // artifact. Vite refuses to serve files outside the project root without this (PLAN T3.1:
    // the contract must be imported, never copied).
    fs: { allow: ['..'] },
  },
});
