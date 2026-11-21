import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Builds ui/src/index.tsx into the committed ESM bundle ui/dist/index.mjs, which Kiro Crew serves at
 * /apps/suture-crew/ui/dist/index.mjs and loads with React.lazy (so the module's default export is the page).
 *
 * Every module the dashboard provides through its import map stays external, so the page shares the host's React
 * instance instead of bundling a second copy. The list mirrors KiroCrew website/scripts/lib/basePath.mjs (VENDOR_IMPORTS).
 */
export const HOST_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@kirocrew/app-sdk',
  '@kirocrew/app-sdk/ui',
  '@tanstack/react-query',
  'lucide-react',
] as const;

const ui = (p: string): string => fileURLToPath(new URL(`../ui/${p}`, import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  build: {
    lib: { entry: ui('src/index.tsx'), formats: ['es'], fileName: () => 'index.mjs' },
    outDir: ui('dist'),
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: { external: [...HOST_EXTERNALS] },
  },
});
