import {defineConfig} from 'tsup';

export default defineConfig({
	entry: ['source/cli.tsx'],
	format: ['esm'],
	target: 'node22',
	platform: 'node',
	outDir: 'dist',
	clean: true,
	// The CLI is an application, not a library — no consumer needs .d.ts,
	// and skipping them keeps the build on esbuild alone.
	dts: false,
	sourcemap: true,
	splitting: false,
	// Ink and React stay external so the published binary resolves them from
	// node_modules rather than inlining two copies of the reconciler.
	external: ['react', 'ink'],
	// No `banner` shebang here — esbuild preserves the one in source/cli.tsx,
	// and a second `#!` on line 2 is a syntax error.
});
