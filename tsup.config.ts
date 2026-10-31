import { defineConfig } from 'tsup'

// ESM and CommonJS for bundlers and Node, and one script-tag build that sets
// window.Basketline. Type declarations come from tsc (see package.json).
export default defineConfig([
  // server: the server entry (@divya2424/basketline-sdk/server), for Node 18+; not in the script-tag build.
  { entry: ['src/index.ts', 'src/server.ts'], format: ['esm', 'cjs'], target: 'es2020', clean: true, sourcemap: true, dts: false },
  {
    entry: { basketline: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Basketline',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    outExtension: () => ({ js: '.global.js' }),
  },
])
