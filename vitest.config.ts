import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  plugins: [
    {
      // Source uses NodeNext-style ".js" specifiers that point at ".ts" files.
      // Map them so Vitest can resolve them during tests.
      name: 'resolve-js-to-ts',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (importer && source.startsWith('.') && source.endsWith('.js')) {
          const resolved = await this.resolve(source.slice(0, -3) + '.ts', importer, { skipSelf: true });
          if (resolved) return resolved;
        }
        return null;
      },
    },
  ],
});
