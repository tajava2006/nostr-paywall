import { defineConfig } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

export default defineConfig({
  test: { environment: 'node' },
  resolve: { alias: workspaceAlias },
});
