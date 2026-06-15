import * as vscode from 'vscode';
import type { AssignmentCheck, CsptAssignment, CsptAssignmentData } from './types';
import { exists } from '../utils';

declare const TextDecoder: {
	new(): { decode(input?: Uint8Array): string };
};

declare const TextEncoder: {
	new(): { encode(input?: string): Uint8Array };
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();
export const assignmentDataFileName = '.cspt.dat';
const importModule = new Function('specifier', 'return import(specifier);') as <T>(specifier: string) => Promise<T>;

interface CsptUnpacker {
	id(): Promise<string>;
	displayName(): Promise<string>;
	description(): Promise<string>;
	checks(includeHidden?: boolean): Promise<AssignmentCheck[]>;
	templateFiles(): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>;
}

interface CsptUnpackerModule {
	readonly Unpacker: new (bundleBytes: Uint8Array) => CsptUnpacker;
}

export async function loadCsptAssignment(extensionUri: vscode.Uri, uri: vscode.Uri): Promise<CsptAssignment> {
	const unpacker = await loadCsptUnpacker(extensionUri, uri);
	return loadCsptAssignmentFromUnpacker(uri, unpacker);
}

export async function loadCsptAssignmentFromBytes(extensionUri: vscode.Uri, uri: vscode.Uri, bytes: Uint8Array): Promise<CsptAssignment> {
	const unpacker = await loadCsptUnpackerFromBytes(extensionUri, bytes);
	return loadCsptAssignmentFromUnpacker(uri, unpacker);
}

async function loadCsptAssignmentFromUnpacker(uri: vscode.Uri, unpacker: CsptUnpacker): Promise<CsptAssignment> {
	const [id, displayName, description, checks] = await Promise.all([
		unpacker.id(),
		unpacker.displayName(),
		unpacker.description(),
		unpacker.checks(true)
	]);
	return { uri, id, displayName, description, checks };
}

export async function loadCsptUnpacker(extensionUri: vscode.Uri, uri: vscode.Uri): Promise<CsptUnpacker> {
	return loadCsptUnpackerFromBytes(extensionUri, await vscode.workspace.fs.readFile(uri));
}

export async function loadCsptUnpackerFromBytes(extensionUri: vscode.Uri, bytes: Uint8Array): Promise<CsptUnpacker> {
	const module = await importModule<CsptUnpackerModule>(vscode.Uri.joinPath(extensionUri, 'lib', 'cspt-unpacker', 'index.js').toString());
	return new module.Unpacker(bytes);
}

export async function readAssignmentData(workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<CsptAssignmentData | undefined> {
	if (!workspaceFolder) {
		return undefined;
	}
	const uri = assignmentDataUri(workspaceFolder);
	if (!await exists(uri)) {
		return undefined;
	}
	return JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(uri))) as CsptAssignmentData;
}

export async function writeAssignmentData(workspaceFolder: vscode.WorkspaceFolder, data: CsptAssignmentData): Promise<void> {
	await vscode.workspace.fs.writeFile(assignmentDataUri(workspaceFolder), encoder.encode(`${JSON.stringify(data, null, 2)}\n`));
}

export function assignmentDataUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(workspaceFolder.uri, assignmentDataFileName);
}

export function assignmentPath(workspaceFolder: vscode.WorkspaceFolder, path: string): vscode.Uri {
	return vscode.Uri.joinPath(workspaceFolder.uri, ...path.split('/').filter(Boolean));
}
