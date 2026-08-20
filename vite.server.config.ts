import { defineConfig } from 'vite'

/**
 * Production build of the BFF: one bundled ESM file, `node_modules` left
 * external. Vite already ships with this repo for the SPA, so bundling the
 * server this way costs no extra dependency — and it means the runtime image
 * needs neither a TypeScript loader nor the dev dependencies.
 */
export default defineConfig({
  // Bundle the runtime dependencies in too: the image then needs no
  // node_modules at all, which is both smaller and one less thing to keep in
  // sync between the build stage and the runtime stage.
  ssr: { noExternal: true },
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'index.js' },
    },
  },
})
