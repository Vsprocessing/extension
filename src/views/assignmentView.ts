import * as vscode from 'vscode';
import { loadCsptAssignment, loadCsptAssignmentFromBytes, readAssignmentData } from '../assignment/assignmentLoader';
import type { AssignmentCheck, AssignmentViewState, CsptAssignment } from '../assignment/types';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

type AssignmentViewMessage =
	| { readonly type: 'start' }
	| { readonly type: 'restart' }
	| { readonly type: 'evaluate' };

export interface AssignmentViewController {
	startAssignment(assignment: CsptAssignment): Promise<void>;
	restartAssignment(assignment: CsptAssignment): Promise<void>;
	evaluateAssignment(assignment: CsptAssignment): Promise<void>;
	downloadAssignment(assignment: CsptAssignment, bytes: Uint8Array): Promise<vscode.Uri | undefined>;
}

export class AssignmentViewProvider implements vscode.CustomReadonlyEditorProvider {
	static readonly viewType = 'webprocessing.csptAssignment';

	private readonly panels = new Map<string, vscode.WebviewPanel>();
	private readonly running = new Set<string>();
	private readonly previews = new Map<string, Uint8Array>();
	private previewKey: string | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: AssignmentViewController
	) { }

	async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		return { uri, dispose() { } };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		const key = document.uri.toString();
		this.panels.set(key, panel);
		panel.webview.options = { enableScripts: true };
		panel.webview.onDidReceiveMessage(message => this.handleMessage(document.uri, message));
		panel.onDidDispose(() => {
			this.panels.delete(key);
			this.previews.delete(key);
			if (this.previewKey === key) {
				this.previewKey = undefined;
			}
		});
		await this.refresh(document.uri);
	}

	async refresh(uri: vscode.Uri): Promise<void> {
		const panel = this.panels.get(uri.toString());
		if (!panel) {
			return;
		}
		panel.webview.html = await this.getHtml(await this.loadAssignment(uri));
	}

	async openPreview(id: string, bytes: Uint8Array): Promise<void> {
		if (this.previewKey) {
			this.panels.get(this.previewKey)?.dispose();
			this.previews.delete(this.previewKey);
		}
		const uri = vscode.Uri.from({ scheme: 'webprocessing-cspt-preview', path: `/${this.previewFileName(id)}` });
		this.previewKey = uri.toString();
		this.previews.set(this.previewKey, bytes);
		await vscode.commands.executeCommand('vscode.openWith', uri, AssignmentViewProvider.viewType, { preview: true });
	}

	private async handleMessage(uri: vscode.Uri, message: AssignmentViewMessage): Promise<void> {
		const key = uri.toString();
		if (this.running.has(key)) {
			return;
		}
		const assignment = await this.loadAssignment(uri);
		switch (message.type) {
			case 'start':
				if (this.isPreview(uri)) {
					const bytes = this.previews.get(uri.toString());
					if (bytes) {
						const downloaded = await this.controller.downloadAssignment(assignment, bytes);
						if (downloaded) {
							await vscode.commands.executeCommand('vscode.openWith', downloaded, AssignmentViewProvider.viewType);
							this.panels.get(key)?.dispose();
						}
					}
				} else {
					await this.controller.startAssignment(assignment);
				}
				break;
			case 'restart':
				await this.controller.restartAssignment(assignment);
				break;
			case 'evaluate':
				this.running.add(key);
				await this.update(uri);
				try {
					await this.controller.evaluateAssignment(assignment);
				} finally {
					this.running.delete(key);
				}
				break;
		}
		await this.update(uri);
	}

	private async update(uri: vscode.Uri): Promise<void> {
		const panel = this.panels.get(uri.toString());
		if (!panel) {
			return;
		}
		await panel.webview.postMessage({ type: 'state', state: await this.getState(await this.loadAssignment(uri)) });
	}

	private async getHtml(assignment: CsptAssignment): Promise<string> {
		const nonce = createNonce();
		return renderTemplate(await readTemplate(this.extensionUri, 'assignment-view.html'), {
			nonce,
			initialState: escapeScriptJson(JSON.stringify(await this.getState(assignment)))
		});
	}

	private async getState(assignment: CsptAssignment): Promise<AssignmentViewState> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const data = await readAssignmentData(workspaceFolder);
		const active = data?.id === assignment.id;
		const preview = this.isPreview(assignment.uri);
		const running = this.running.has(assignment.uri.toString());
		const results = new Map((active ? data.results ?? [] : []).map(result => [result.id, result]));
		return {
			id: assignment.id,
			displayName: assignment.displayName,
			description: assignment.description,
			started: active,
			preview,
			hasWorkspace: !!workspaceFolder,
			running,
			results: assignment.checks.map(check => {
				const result = results.get(check.id);
				return {
					id: check.id,
					displayName: this.checkDisplayName(check),
					description: check.hidden ? undefined : check.description,
					passed: result?.passed,
					evaluatedAt: result?.evaluatedAt,
					reason: result?.reason
				};
			}),
			message: !workspaceFolder
				? 'Open a workspace folder before downloading or starting an assignment.'
				: active
					? ''
					: preview
						? 'Download the assignment into this workspace to begin.'
						: 'Start the assignment to extract template files into this workspace.'
		};
	}

	private async loadAssignment(uri: vscode.Uri): Promise<CsptAssignment> {
		const bytes = this.previews.get(uri.toString());
		return bytes
			? loadCsptAssignmentFromBytes(this.extensionUri, uri, bytes)
			: loadCsptAssignment(this.extensionUri, uri);
	}

	private isPreview(uri: vscode.Uri): boolean {
		return this.previews.has(uri.toString());
	}

	private previewFileName(id: string): string {
		return `Preview: ${id.replace(/[\\/]/g, '-')}.cspt`;
	}

	private checkDisplayName(check: AssignmentCheck): string {
		if (check.hidden) {
			return 'Hidden check';
		}
		const name = check.displayName ?? check.id;
		return `${check.id}: ${name}`;
	}
}
