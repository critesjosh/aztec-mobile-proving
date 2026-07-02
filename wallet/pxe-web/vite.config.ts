import { defineConfig, type Plugin } from 'vite';
import { type PolyfillOptions, nodePolyfills } from 'vite-plugin-node-polyfills';

// Workaround for vite-plugin-node-polyfills shim resolution (per Aztec webapp tutorial).
const nodePolyfillsFix = (options?: PolyfillOptions): Plugin => ({
  ...nodePolyfills(options),
  resolveId(source: string) {
    const m = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(source);
    if (m) {
      return `./node_modules/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.cjs`;
    }
  },
});

// Served by the app's loopback AssetHttpServer at http://127.0.0.1:38271 —
// a real secure origin, so no single-file inlining is needed (unlike the
// rn-spike file:// bundle): ES modules, workers, and .wasm assets all load
// as plain relative-path files.
export default defineConfig({
  base: './',
  plugins: [nodePolyfillsFix({ globals: { process: true, Buffer: true } })],
  optimizeDeps: {
    include: ['pino', 'pino/browser'],
    // Don't pre-bundle WASM-containing packages (corrupts the .wasm).
    exclude: ['@aztec/noir-noirc_abi', '@aztec/noir-acvm_js', '@aztec/bb.js', '@aztec/noir-noir_js'],
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: { output: { inlineDynamicImports: false } },
  },
  worker: { format: 'es' },
});
