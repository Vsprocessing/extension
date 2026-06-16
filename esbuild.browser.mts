/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import esbuild from 'esbuild';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist', 'browser');

const options: esbuild.BuildOptions = {
	platform: 'browser',
	bundle: true,
	minify: true,
	treeShaking: true,
	sourcemap: true,
	target: ['es2024'],
	external: ['vscode'],
	format: 'cjs',
	mainFields: ['browser', 'module', 'main'],
	alias: {
		'path': 'path-browserify',
	},
	define: {
		'import.meta.url': '__webprocessingImportMetaUrl',
		'process.platform': JSON.stringify('web'),
		'process.env': JSON.stringify({}),
		'process.env.BROWSER_ENV': JSON.stringify('true'),
	},
	banner: {
		js: `var __webprocessingImportMetaUrl = (() => {
	try {
		throw new Error();
	} catch (error) {
		const match = String(error?.stack ?? '').match(/https?:\\/\\/\\S+\\/dist\\/browser\\/extension\\.js/);
		return match?.[0] ?? globalThis.location?.href ?? 'http://localhost/';
	}
})();`
	},
	logOverride: {
		'import-is-undefined': 'error',
	},
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
	},
	outdir: outDir,
	tsconfig: path.join(import.meta.dirname, 'tsconfig.browser.json'),
};

if (process.argv.includes('--watch')) {
	const context = await esbuild.context(options);
	await context.watch();
	await afterBuild();
	console.log('[watch] webprocessing browser bundle is watching');
} else {
	try {
		await esbuild.build(options);
		await afterBuild();
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}

async function afterBuild(): Promise<void> {
	const pdfjsOutDir = path.join(import.meta.dirname, 'media', 'pdfjs');
	const pdfjsBuildDir = path.join(import.meta.dirname, 'node_modules', 'pdfjs-dist', 'build');
	const pdfjsBuildOutDir = path.join(pdfjsOutDir, 'build');
	await mkdir(pdfjsBuildOutDir, { recursive: true });
	await copyFile(path.join(pdfjsBuildDir, 'pdf.mjs'), path.join(pdfjsBuildOutDir, 'pdf.mjs'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.mjs.map'), path.join(pdfjsBuildOutDir, 'pdf.mjs.map'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.worker.mjs'), path.join(pdfjsBuildOutDir, 'pdf.worker.mjs'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.worker.mjs.map'), path.join(pdfjsBuildOutDir, 'pdf.worker.mjs.map'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.sandbox.mjs'), path.join(pdfjsBuildOutDir, 'pdf.sandbox.mjs'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.sandbox.mjs.map'), path.join(pdfjsBuildOutDir, 'pdf.sandbox.mjs.map'));
	await copyFile(
		path.join(import.meta.dirname, 'node_modules', 'cspt-unpacker', 'cspt-core.wasm'),
		path.join(outDir, 'cspt-core.wasm')
	);
}
