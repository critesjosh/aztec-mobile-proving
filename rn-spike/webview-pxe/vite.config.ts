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

export default defineConfig({
  plugins: [nodePolyfillsFix({ globals: { process: true, Buffer: true } })],
  server: {
    // COOP/COEP so SharedArrayBuffer is available (bb WASM would need it; we
    // offload proving to native, but acvm_js is happier isolated too).
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    include: ['pino', 'pino/browser'],
    // Don't pre-bundle WASM-containing packages (corrupts the .wasm).
    exclude: ['@aztec/noir-noirc_abi', '@aztec/noir-acvm_js', '@aztec/bb.js', '@aztec/noir-noir_js'],
  },
  build: {
    target: 'es2022',
    // Single self-contained bundle we can drop into the RN app's assets and
    // load in a WebView from file:// (no dev server on device).
    assetsInlineLimit: 0,
    rollupOptions: { output: { inlineDynamicImports: false } },
  },
});
