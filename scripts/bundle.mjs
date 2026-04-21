#!/usr/bin/env node
// Bundles src/index.ts into a single ESM file with all deps inlined.
// Output: ../backend/src/mcp-bundle.js (committed) — used by backend to
// embed the MCP server into .mcpb files so end-users don't need Node/npx.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const outfile = new URL('../../backend/src/mcp-bundle.js', import.meta.url).pathname;
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  minify: false,
  external: [],
  logLevel: 'info',
});

console.log(`✓ bundled → ${outfile}`);
