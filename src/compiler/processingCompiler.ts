import * as vscode from 'vscode';
import type { CreateCompilerOptions } from '@worldeditaxe/teavm-javac';
import type { BuildOutputKind, ProcessingOutputTarget } from '../core/types';
import { TeaVmPackage } from './teavmPackage';
import {
	formatDiagnostic, stripExtension, stripWasmExtension, toJavaIdentifier,
	type SourceKind, type WorkspaceSource
} from '../utils';

export interface CompilerOutput {
	readonly output: BuildOutputKind;
	readonly name: string;
	readonly bytes?: Uint8Array;
	readonly text?: string;
}

export class ProcessingCompiler {
	private readonly teavm: TeaVmPackage;

	constructor(
		extensionUri: vscode.Uri,
		private readonly log: (message?: string) => void
	) {
		this.teavm = new TeaVmPackage(extensionUri);
	}

	async compile(mode: SourceKind, sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string, processingOutput: ProcessingOutputTarget): Promise<CompilerOutput> {
		return mode === 'processing'
			? this.compileProcessing(sources, mainSource, targetFileName, processingOutput)
			: this.compileJava(sources, mainSource, targetFileName);
	}

	assetUri(name: string): vscode.Uri {
		return this.teavm.assetUri(name);
	}

	assetImportUri(name: string): string {
		return this.teavm.assetImportUri(name);
	}

	private async compileProcessing(sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string, processingOutput: ProcessingOutputTarget): Promise<CompilerOutput> {
		this.log('\n[compiler] Loading Processing compiler...');
		const processing = await this.teavm.processing();
		const core = await vscode.workspace.fs.readFile(this.assetUri('processing-core-teavm.jar'));

		this.log('[compiler] Compiling Processing sketch...');
		const generated = await processing.generateProcessingSketch([...sources], {
			core,
			sketchName: toJavaIdentifier(stripExtension(mainSource.path ?? 'Sketch'), 'Sketch'),
			sourceMaps: false,
			target: processingOutput,
			output: processingOutput,
			backend: 'canvas2d',
			optimizationLevel: 'simple',
			fastGlobalAnalysis: true,
			worker: false,
			wasmOutputName: stripWasmExtension(targetFileName),
			fallbackToJs: processingOutput === 'auto',
			compilerOptions: this.compilerOptions(),
			onDiagnostic: diagnostic => {
				this.log(formatDiagnostic(diagnostic));
			}
		});
		for (const diagnostic of generated.diagnostics ?? []) {
			this.log(formatDiagnostic(diagnostic));
		}

		if (generated.output === 'wasm-gc' && generated.wasmBytes) {
			this.log('[compiler] Compiler backend used: wasm-gc');
			if (generated.files?.length) {
				this.log(`[compiler] Generated files: ${generated.files.join(', ')}`);
			}
			return {
				output: 'wasm-gc',
				name: targetFileName,
				bytes: generated.wasmBytes
			};
		}

		if (generated.output === 'js' && generated.moduleText) {
			this.log('[compiler] Compiler backend used: js');
			const name = `${stripWasmExtension(targetFileName)}.js`;
			if (generated.files?.length) {
				this.log(`[compiler] Generated files: ${generated.files.join(', ')}`);
			}
			return {
				output: 'js',
				name,
				text: generated.moduleText
			};
		}

		throw new Error('TeaVM did not produce a valid Processing output.');
	}

	private async compileJava(sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string): Promise<CompilerOutput> {
		this.log('\n[compiler] Loading Java compiler...');
		const module = await this.teavm.compiler();
		const compiler = await module.createCompiler(this.compilerOptions());
		const diagnostics = compiler.onDiagnostic(diagnostic => {
			this.log(formatDiagnostic(diagnostic));
		});

		try {
			for (const source of sources) {
				compiler.addSource(this.javaCompilerSourcePath(source), source.content);
			}

			this.log('[compiler] Compiling Java sources...');
			if (!compiler.compile()) {
				throw new Error('Java compilation failed.');
			}

			const mainClass = this.resolveJavaMainClass(compiler.findMainClasses(), mainSource);
			this.log(`[compiler] Main class: ${mainClass}`);
			const emitted = compiler.emitWasm({
				mainClass,
				outputName: stripWasmExtension(targetFileName),
				optimizationLevel: 'simple',
				fastGlobalAnalysis: true
			});

			if (!emitted.ok || !emitted.bytes) {
				throw new Error('TeaVM did not produce a valid WebAssembly output.');
			}
			this.log('[compiler] Compiler backend used: wasm-gc');
			if (emitted.files.length) {
				this.log(`[compiler] Generated files: ${emitted.files.join(', ')}`);
			}
			return {
				output: 'wasm-gc',
				name: targetFileName,
				bytes: new Uint8Array(emitted.bytes)
			};
		} finally {
			diagnostics.dispose();
		}
	}

	private resolveJavaMainClass(mainClasses: readonly string[], mainSource: WorkspaceSource): string {
		if (mainClasses.length === 0) {
			throw new Error('No Java main class was found.');
		}
		const sourceClass = toJavaIdentifier(stripExtension(mainSource.path ?? 'Main').split('/').pop() ?? 'Main', 'Main');
		const matched = mainClasses.find(candidate => candidate === sourceClass || candidate.endsWith(`.${sourceClass}`));
		if (matched) {
			return matched;
		}
		if (mainClasses.length === 1) {
			return mainClasses[0];
		}
		throw new Error(`Multiple Java main classes found: ${mainClasses.join(', ')}. Use main.java or the workspace folder name for the entrypoint.`);
	}

	private javaCompilerSourcePath(source: WorkspaceSource): string {
		return /^\s*package\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*;/m.test(source.content)
			? source.path
			: source.path.split('/').pop() ?? source.path;
	}

	private compilerOptions(): CreateCompilerOptions {
		return {
			backend: 'wasm-gc',
			compilerWasmUrl: this.assetUri('compiler.wasm').toString(),
			compilerWasmRuntimeUrl: this.assetImportUri('compiler.wasm-runtime.js'),
			javacClasslibUrl: this.assetUri('compile-classlib-teavm.bin').toString(),
			runtimeClasslibUrl: this.assetUri('runtime-classlib-teavm.bin').toString(),
			fallbackToJs: false
		};
	}
}
