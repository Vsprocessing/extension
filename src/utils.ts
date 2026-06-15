import * as vscode from 'vscode';
import type { ProcessingDiagnostic, ProcessingSketchTimings } from '@worldeditaxe/teavm-javac/processing';
import type { ProcessingPreprocessResult } from '@worldeditaxe/teavm-javac';

declare const TextDecoder: {
	new(): { decode(input?: Uint8Array): string };
};

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

// handle sources
export interface WorkspaceSource {
	readonly uri: vscode.Uri;
	readonly path: string;
	readonly content: string;
}

export type SourceKind = 'java' | 'processing';
export type SourceOrigin = 'workspace' | 'tabs';

export interface SourceCollection {
	readonly kind: SourceKind;
	readonly origin: SourceOrigin;
	readonly workspaceFolders: readonly vscode.WorkspaceFolder[];
	readonly sources: readonly WorkspaceSource[];
}

export async function collectSources(kind: SourceKind): Promise<SourceCollection> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length) {
		const sources: WorkspaceSource[] = [];
		sources.push(...await collectWorkspaceSources(workspaceFolders[0].uri, sourceExtension(kind)));

		return { kind, origin: 'workspace', workspaceFolders, sources };
	}

	return { kind, origin: 'tabs', workspaceFolders: [], sources: collectTabSources(kind) };
}

async function collectWorkspaceSources(root: vscode.Uri, extension: string): Promise<WorkspaceSource[]> {
	const result: WorkspaceSource[] = [];
	async function visit(folder: vscode.Uri, relativeFolder: string): Promise<void> {
		const entries = await vscode.workspace.fs.readDirectory(folder);
		entries.sort(([a], [b]) => a.localeCompare(b));
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(folder, name);
			const relativePath = relativeFolder ? `${relativeFolder}/${name}` : name;
			if (type === vscode.FileType.Directory) {
				if (name === '.git' || name === 'node_modules') {
					continue;
				}
				await visit(child, relativePath);
			} else if (type === vscode.FileType.File && name.toLowerCase().endsWith(extension)) {
				const bytes = await vscode.workspace.fs.readFile(child);
				result.push({ uri: child, path: relativePath, content: new TextDecoder().decode(bytes) });
			}
		}
	}
	await visit(root, '');
	return result;
}

function collectTabSources(kind: SourceKind): WorkspaceSource[] {
	const sources: WorkspaceSource[] = [];
	for (const document of vscode.workspace.textDocuments) {
		if (!isSourceUri(document.uri, kind)) {
			continue;
		}
		sources.push({
			uri: document.uri,
			path: tabSourceName(document),
			content: document.getText()
		});
	}
	sources.sort((a, b) => a.path.localeCompare(b.path));
	return sources;
}

function tabSourceName(document: vscode.TextDocument): string {
	const path = document.uri.path.split('/').pop();
	return path || document.fileName || `main${sourceExtension(isProcessingUri(document.uri) ? 'processing' : 'java')}`;
}

function sourceExtension(kind: SourceKind): string {
	return kind === 'processing' ? '.pde' : '.java';
}

export function hasSources(kind: SourceKind): boolean {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length) {
		return true;
	}

	return vscode.workspace.textDocuments.some(document => isSourceUri(document.uri, kind));
}

export function sourceVersions(sources: readonly WorkspaceSource[]): ReadonlyMap<string, number> {
	const versions = new Map<string, number>();
	for (const source of sources) {
		const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === source.uri.toString());
		if (document) {
			versions.set(source.uri.toString(), document.version);
		}
	}
	return versions;
}

// we keep track of the sources that produced the artifact,
// and compare current versions with the recorded ones to determine if the artifact is outdated.
// the artifact is temporary so we can just use the in-memory version param.
export function isTempBuildArtifactOutdated(versions: ReadonlyMap<string, number>): boolean {
	for (const [uri, version] of versions) {
		const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri);
		if (!document || document.version !== version) {
			return true;
		}
	}
	return false;
}

// check if any .pde/.java file in the workspace folder is newer than the compiled file
// artifact is on disk so we need to check the file modification times
export async function isBuildArtifactOutdated(workspaceFolder: vscode.WorkspaceFolder, compiledMtime: number): Promise<boolean> {
	for (const document of vscode.workspace.textDocuments) {
		if (document.isDirty && isSourceUri(document.uri) && isInWorkspaceFolder(document.uri, workspaceFolder)) {
			return true;
		}
	}

	for (const kind of ['processing', 'java'] satisfies SourceKind[]) {
		const collection = await collectSources(kind);
		for (const source of collection.sources) {
			const stat = await statOrUndefined(source.uri);
			if (stat && stat.mtime > compiledMtime) {
				return true;
			}
		}
	}

	return false;
}

export function isProcessingUri(uri: vscode.Uri): boolean {
	return uri.path.toLowerCase().endsWith('.pde');
}

export function isJavaUri(uri: vscode.Uri): boolean {
	return uri.path.toLowerCase().endsWith('.java');
}

function isSourceUri(uri: vscode.Uri, kind?: SourceKind): boolean {
	if (kind) {
		return kind === 'processing' ? isProcessingUri(uri) : isJavaUri(uri);
	}
	return isProcessingUri(uri) || isJavaUri(uri);
}

export function isInWorkspaceFolder(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): boolean {
	if (uri.scheme !== workspaceFolder.uri.scheme || uri.authority !== workspaceFolder.uri.authority) {
		return false;
	}
	const folderPath = workspaceFolder.uri.path.endsWith('/') ? workspaceFolder.uri.path : `${workspaceFolder.uri.path}/`;
	return uri.path === workspaceFolder.uri.path || uri.path.startsWith(folderPath);
}

export function identifyEntrypoint<T extends { readonly path?: string }>(sources: readonly T[], workspaceFolder?: vscode.WorkspaceFolder): T | undefined {
	const candidates = workspaceFolder
		? [
			`${workspaceFolder.name.toLowerCase()}.pde`,
			`${workspaceFolder.name.toLowerCase()}.java`,
			'main.pde',
			'main.java'
		]
		: [
			'main.pde',
			'main.java'
		];

	for (const candidate of candidates) {
		const index = sources.findIndex(source => source.path?.toLowerCase().split('/').pop() === candidate);
		if (index >= 0) {
			return sources[index];
		}
	}

	return undefined;
}

export function buildArtifactFileUri(workspaceFolder: vscode.WorkspaceFolder, extension: 'wasm' | 'js' = 'wasm'): vscode.Uri {
	return vscode.Uri.joinPath(workspaceFolder.uri, buildArtifactFileName(workspaceFolder, extension));
}

export function buildArtifactFileName(workspaceFolder: vscode.WorkspaceFolder, extension: 'wasm' | 'js' = 'wasm'): string {
	return `${toFileBaseName(workspaceFolder.name, 'sketch')}.compiled.${extension}`;
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

// get file metadata
export async function statOrUndefined(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}

export function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

export function stripExtension(path: string): string {
	const basename = path.split('/').pop() ?? path;
	return basename.replace(/\.[^.]+$/, '');
}

export function toJavaIdentifier(value: string, fallback: string): string {
	const identifier = value.replace(/^[^A-Za-z_$]+/, '').replace(/[^A-Za-z0-9_$]/g, '_');
	return identifier || fallback;
}

function toFileBaseName(value: string, fallback: string): string {
	const fileName = value.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '').trim();
	return fileName || fallback;
}

export function stripWasmExtension(fileName: string): string {
	return fileName.toLowerCase().endsWith('.wasm') ? fileName.slice(0, -'.wasm'.length) : fileName;
}

export function formatDiagnostic(diagnostic: ProcessingDiagnostic): string {
	const type = diagnostic.type ?? 'compiler';
	const severity = diagnostic.severity ?? 'other';
	const file = diagnostic.fileName ? `${diagnostic.fileName}` : 'unknown';
	const line = diagnostic.lineNumber ? `:${diagnostic.lineNumber}` : '';
	const column = diagnostic.columnNumber ? `:${diagnostic.columnNumber}` : '';
	const message = diagnostic.message ?? String(diagnostic);
	return `[compiler] ${file}${line}${column}: ${type} ${severity}: ${message}`.trim();
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTimings(timings: ProcessingSketchTimings): string {
	const parts: string[] = [];
	if (typeof timings.compileMs === 'number') {
		parts.push(`compile ${formatDuration(timings.compileMs)}`);
	}
	if (typeof timings.emitMs === 'number') {
		parts.push(`emit ${formatDuration(timings.emitMs)}`);
	}
	if (typeof timings.totalMs === 'number') {
		parts.push(`total ${formatDuration(timings.totalMs)}`);
	}
	if (typeof timings.workerStartupMs === 'number') {
		parts.push(`worker startup ${formatDuration(timings.workerStartupMs)}`);
	}
	if (typeof timings.compileRequestMs === 'number') {
		parts.push(`compile request ${formatDuration(timings.compileRequestMs)}`);
	}
	return parts.length ? parts.join(', ') : 'not reported';
}

export interface ProcessingCompileLikeError {
	readonly preprocessed?: ProcessingPreprocessResult;
	readonly diagnostics?: readonly ProcessingDiagnostic[];
}

export function createNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function escapeScriptJson(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\u003C');
}

const templateDecoder = new TextDecoder();

export async function readTemplate(extensionUri: vscode.Uri, name: string): Promise<string> {
	const uri = vscode.Uri.joinPath(extensionUri, 'media', 'templates', name);
	return templateDecoder.decode(await vscode.workspace.fs.readFile(uri));
}

export function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}
