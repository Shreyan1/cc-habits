import { buildSync } from 'esbuild';
import { chmodSync } from 'fs';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  // Keep @anthropic-ai/sdk external to avoid bundling issues with its internal dynamic requires
  external: ['@anthropic-ai/sdk'],
};

buildSync({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
buildSync({ ...shared, entryPoints: ['src/hook-entry.ts'], outfile: 'dist/hook-entry.js' });

chmodSync('dist/index.js', 0o755);
chmodSync('dist/hook-entry.js', 0o755);

console.log('build: dist/index.js dist/hook-entry.js');
