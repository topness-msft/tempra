import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * The server compiles under NodeNext, so its sources import siblings as
 * "./thing.js". Vite resolves that literally and fails on a TypeScript file, so
 * map the specifier back to the source when the source is what exists.
 */
const nodeNextTs = (): Plugin => ({
  name: 'nodenext-ts-resolver',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + '.ts');
    return existsSync(candidate) ? candidate : null;
  },
});

export default defineConfig({
  plugins: [nodeNextTs()],
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
