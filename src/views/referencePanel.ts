import * as vscode from 'vscode';
import { referenceViewType } from '../core/constants';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

export class ProcessingReferencePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;

	constructor(
		private readonly extensionUri: vscode.Uri,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(referenceViewType, 'Reference', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
		});
		this.panel.onDidDispose(onDispose);
	}

	dispose(): void {
		this.panel.dispose();
	}

	async open(title: string, source: string | vscode.Uri): Promise<void> {
		this.panel.title = title;
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.panel.webview.html = await this.getHtml(title, source);
	}

	private async getHtml(title: string, source: string | vscode.Uri): Promise<string> {
		const nonce = createNonce();
		const url = typeof source === 'string' ? source : this.panel.webview.asWebviewUri(source).toString();
		const isPdf = typeof source !== 'string' && source.path.toLowerCase().endsWith('.pdf');
		const payload = escapeScriptJson(JSON.stringify({
			title,
			url,
			kind: isPdf ? 'pdf' : 'web',
			pdfViewerPageUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs', 'web', 'viewer.html')).toString()
		}));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-reference.html'), {
			nonce,
			payload,
			cspSource: this.panel.webview.cspSource
		});
	}
}
