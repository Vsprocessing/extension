import * as vscode from 'vscode';
import type { SourceKind } from '../utils';

export type ProcessingOutputTarget = 'auto' | 'wasm-gc' | 'js';
export type BuildOutputKind = 'wasm-gc' | 'js';

export interface BuildArtifact {
	readonly mode: SourceKind;
	readonly scope: string;
	readonly name: string;
	readonly output?: BuildOutputKind;
	readonly uri?: vscode.Uri;
	readonly bytes?: Uint8Array;
	readonly text?: string;
	readonly sourceVersions?: ReadonlyMap<string, number>;
	readonly outdated: boolean;
}

export interface ExtensionState {
	readonly mode: SourceKind;
	readonly processingOutput: ProcessingOutputTarget;
	readonly hasSources: boolean;
	readonly hasCompiled: boolean;
	readonly isCompiling: boolean;
	readonly isRunning: boolean;
	readonly isOutdated: boolean;
}

export interface ExtensionControlsViewState extends ExtensionState {
	readonly status: string;
	readonly warning: string;
}

export interface ExtensionController {
	getState(): ExtensionState;
	setMode(mode: SourceKind): void;
	setProcessingOutput(output: ProcessingOutputTarget): Promise<void>;
	compile(): Promise<void>;
	run(): Promise<void>;
	exportWebsite(): Promise<void>;
	stop(): void;
	openReference(): Promise<void>;
	openApcsaReference(): Promise<void>;
	openReferenceSheet(): Promise<void>;
}
