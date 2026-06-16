import * as vscode from 'vscode';
import * as compilerPackage from '@worldeditaxe/teavm-javac';
import * as processingPackage from '@worldeditaxe/teavm-javac/processing';

const teavmPackageFiles: Record<string, string> = {
	'': 'teavm-javac.js',
	'processing': 'processing-teavm.js'
};

export function teavmPackageUri(extensionUri: vscode.Uri, exportName = ''): vscode.Uri {
	return vscode.Uri.joinPath(
		extensionUri,
		'node_modules',
		'@worldeditaxe',
		'teavm-javac',
		teavmPackageFiles[exportName] ?? exportName
	);
}

export class TeaVmPackage {
	constructor(private readonly extensionUri: vscode.Uri) { }

	async compiler(): Promise<typeof compilerPackage> {
		return compilerPackage;
	}

	async processing(): Promise<typeof processingPackage> {
		return processingPackage;
	}

	assetUri(name: string): vscode.Uri {
		return teavmPackageUri(this.extensionUri, name);
	}

	assetImportUri(name: string): string {
		return this.assetUri(name).toString();
	}

}
