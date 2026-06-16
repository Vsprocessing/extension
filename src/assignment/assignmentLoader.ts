import * as vscode from 'vscode';
import { Unpacker } from 'cspt-unpacker';
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

export interface AssignmentRoot {
	readonly uri: vscode.Uri;
}

interface CsptUnpacker {
	id(): Promise<string>;
	displayName(): Promise<string>;
	description(): Promise<string>;
	checks(includeHidden?: boolean): Promise<AssignmentCheck[]>;
	templateFiles(): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>;
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

export async function loadCsptUnpackerFromBytes(_extensionUri: vscode.Uri, bytes: Uint8Array): Promise<CsptUnpacker> {
	return new Unpacker(bytes);
}

export async function readAssignmentData(root: AssignmentRoot | undefined): Promise<CsptAssignmentData | undefined> {
	if (!root) {
		return undefined;
	}
	const uri = assignmentDataUri(root);
	if (!await exists(uri)) {
		return undefined;
	}
	return JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(uri))) as CsptAssignmentData;
}

export async function writeAssignmentData(root: AssignmentRoot, data: CsptAssignmentData): Promise<void> {
	await vscode.workspace.fs.writeFile(assignmentDataUri(root), encoder.encode(`${JSON.stringify(data, null, 2)}\n`));
}

export function assignmentDataUri(root: AssignmentRoot): vscode.Uri {
	return vscode.Uri.joinPath(root.uri, assignmentDataFileName);
}

export function assignmentPath(root: AssignmentRoot, path: string): vscode.Uri {
	return vscode.Uri.joinPath(root.uri, ...path.split('/').filter(Boolean));
}
