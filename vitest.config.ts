import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mindchestra/contracts': path.join(rootDir, 'packages/contracts/src/index.ts'),
      '@mindchestra/storage': path.join(rootDir, 'packages/storage/src/index.ts'),
      '@mindchestra/policy': path.join(rootDir, 'packages/policy/src/index.ts'),
      '@mindchestra/workspaces': path.join(rootDir, 'packages/workspaces/src/index.ts'),
      '@mindchestra/core': path.join(rootDir, 'packages/core/src/index.ts'),
      '@mindchestra/mcp-gateway': path.join(rootDir, 'packages/mcp-gateway/src/index.ts'),
      '@mindchestra/mcp-server': path.join(rootDir, 'packages/mcp-server/src/index.ts'),
      '@mindchestra/daemon': path.join(rootDir, 'apps/daemon/src/index.ts'),
      '@mindchestra/adapter-sdk': path.join(rootDir, 'packages/adapter-sdk/src/index.ts'),
      '@mindchestra/adapters': path.join(rootDir, 'packages/adapters/src/index.ts'),
      '@mindchestra/cli': path.join(rootDir, 'apps/cli/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000
  }
});
