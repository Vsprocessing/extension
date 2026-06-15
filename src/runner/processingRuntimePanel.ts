import * as vscode from 'vscode';
import type { BuildOutputKind } from '../core/types';
import { runtimeViewType } from '../core/constants';
import { teavmPackageUri } from '../compiler/teavmPackage';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

export type RuntimeMessage =
	| { readonly type: 'log-raw'; readonly text: string }
	| { readonly type: 'stdout'; readonly text: string }
	| { readonly type: 'stderr'; readonly text: string }
	| { readonly type: 'fileRequest'; readonly id: number; readonly path: string }
	| { readonly type: 'started' }
	| { readonly type: 'stopped' };

export type RuntimeSource =
	| { readonly output: BuildOutputKind; readonly uri: vscode.Uri }
	| { readonly output: 'wasm-gc'; readonly bytes: Uint8Array }
	| { readonly output: 'js'; readonly text: string };

export class ProcessingRuntimePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;
	private pendingSource: RuntimeSource | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly scope: string,
		private readonly localRoot: vscode.Uri | undefined,
		private readonly onMessage: (message: RuntimeMessage) => void,
		onDispose: () => void
	) {
		const teavmRoot = vscode.Uri.joinPath(teavmPackageUri(extensionUri, 'package.json'), '..');
		const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel(runtimeViewType, 'Processing Runtime', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: localRoot ? [teavmRoot, mediaRoot, localRoot] : [teavmRoot, mediaRoot]
		});
		this.panel.webview.onDidReceiveMessage(message => {
			if (message?.type === 'readyForArtifact') {
				if (this.pendingSource && !('uri' in this.pendingSource)) {
					void this.panel.webview.postMessage(this.pendingSource.output === 'js'
						? { type: 'jsText', text: this.pendingSource.text }
						: { type: 'wasmBytes', bytes: this.pendingSource.bytes });
				}
				return;
			}
			if (message?.type === 'fileRequest') {
				void this.handleFileRequest(message);
				return;
			}
			this.onMessage(message);
		});
		this.panel.onDidDispose(onDispose);
	}

	checkScope(scope: string): boolean {
		return this.scope === scope;
	}

	dispose(): void {
		this.panel.dispose();
	}

	async run(source: RuntimeSource): Promise<void> {
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.pendingSource = source;
		this.panel.webview.html = await this.getHtml(source);
	}

	stop(): void {
		this.panel.webview.postMessage({ type: 'stop' });
	}

	private async getHtml(source: RuntimeSource): Promise<string> {
		const nonce = createNonce();
		const payload = escapeScriptJson(JSON.stringify({
			output: source.output,
			artifactUri: 'uri' in source ? this.panel.webview.asWebviewUri(source.uri).toString() : '',
			wasmRuntimeUri: this.panel.webview.asWebviewUri(teavmPackageUri(this.extensionUri, 'compiler.wasm-runtime.js')).toString(),
			processingUri: this.panel.webview.asWebviewUri(teavmPackageUri(this.extensionUri, 'processing')).toString(),
			p5Uri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'p5.min.js')).toString()
		}));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-runtime.html'), {
			nonce,
			payload,
			cspSource: this.panel.webview.cspSource
		});
	}

	private async handleFileRequest(message: { readonly id: number; readonly path: string }): Promise<void> {
		if (!this.localRoot) {
			await this.postFileResponse(message.id, false, undefined, 'No workspace folder is available.');
			return;
		}

		const parts = this.runtimePathParts(message.path);
		if (!parts) {
			await this.postFileResponse(message.id, false, undefined, 'Invalid runtime file path.');
			return;
		}

		try {
			const uri = vscode.Uri.joinPath(this.localRoot, ...parts);
			const bytes = await vscode.workspace.fs.readFile(uri);
			await this.postFileResponse(message.id, true, bytes, undefined, this.mimeType(parts.at(-1) ?? ''));
		} catch (error) {
			await this.postFileResponse(message.id, false, undefined, String(error));
		}
	}

	private postFileResponse(id: number, ok: boolean, bytes?: Uint8Array, error?: string, mime = 'application/octet-stream'): Thenable<boolean> {
		return this.panel.webview.postMessage({
			type: 'fileResponse',
			id,
			ok,
			mime,
			error,
			bytes: bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : undefined
		});
	}

	private runtimePathParts(path: string): string[] | undefined {
		const parts = path.split(/[\\/]+/).filter(Boolean);
		if (!parts.length || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
			return undefined;
		}
		return parts;
	}

	private mimeType(name: string): string {
		const extension = name.toLowerCase().split('.').pop();
		switch (extension) {
			case 'png':
				return 'image/png';
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'gif':
				return 'image/gif';
			case 'webp':
				return 'image/webp';
			case 'svg':
				return 'image/svg+xml';
			case 'txt':
				return 'text/plain';
			case 'json':
				return 'application/json';
			default:
				return 'application/octet-stream';
		}
	}
}
