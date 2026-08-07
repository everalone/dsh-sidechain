/**
 * tsdown preset for the dsh-sidechain node half: one ESM bundle with
 * declarations. All @deepseek-ai packages are type-only imports (erased at
 * build); schemastery stays external because the Loader validates the plugin's
 * `Config` schema and must see its own schemastery instance.
 */
import type { UserConfig } from 'tsdown'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      // schemastery stays unbundled because the Loader validates the plugin's
      // `Config` schema and must see its own schemastery instance; cordis is
      // type-only in this bundle.
      neverBundle: ['schemastery', 'cordis'],
    },
  },
] satisfies UserConfig[]
