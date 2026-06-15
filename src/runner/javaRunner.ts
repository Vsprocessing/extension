import * as vscode from 'vscode';
import type { BuildArtifact } from '../core/types';

interface JavaRuntimeMessage {
	readonly type?: string;
	readonly text?: string;
	readonly level?: string;
}

export class JavaRunner implements vscode.Disposable {
	private worker: Worker | undefined;
	private runId = 0;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runtimeUri: () => string,
		private readonly log: (message?: string) => void,
		private readonly appendOutput: (message?: string) => void,
		private readonly showOutput: () => void,
		private readonly setRunning: (running: boolean) => void,
		private readonly refreshState: () => Promise<void>
	) { }

	dispose(): void {
		this.stop(false);
	}

	async run(artifact: BuildArtifact): Promise<void> {
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...\n`);
		this.stop(false);
		this.setRunning(true);
		await this.refreshState();

		try {
			const runId = ++this.runId;
			const sourceBytes = artifact.bytes ?? await vscode.workspace.fs.readFile(artifact.uri!);
			const wasmBytes = new Uint8Array(sourceBytes);
			const worker = new Worker(vscode.Uri.joinPath(this.extensionUri, 'media', 'java-runtime-worker.js').toString(), {
				name: 'webprocessing-java-runtime'
			});
			this.worker = worker;
			worker.onmessage = event => this.handleMessage(runId, event.data);
			worker.onerror = event => {
				if (runId !== this.runId) {
					return;
				}
				this.log(`[runtime] ${event.message}`);
				this.stop(false);
				this.setRunning(false);
				void this.refreshState();
			};
			worker.postMessage({
				type: 'run',
				runtimeUri: this.runtimeUri(),
				wasmBytes,
				capture: false
			}, [wasmBytes.buffer]);
		} catch (error) {
			this.log(`[runtime] ${error}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
			this.setRunning(false);
			await this.refreshState();
		}
	}

	async runForOutput(artifact: BuildArtifact, input: string): Promise<{ stdout: string; stderr: string; error?: string }> {
		this.stop(false);
		const sourceBytes = artifact.bytes ?? await vscode.workspace.fs.readFile(artifact.uri!);
		const wasmBytes = new Uint8Array(sourceBytes);
		const runId = ++this.runId;
		let worker: Worker | undefined;
		return new Promise(resolve => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (result: { stdout: string; stderr: string; error?: string }) => {
				if (settled) {
					return;
				}
				settled = true;
				worker?.terminate();
				if (runId === this.runId && this.worker === worker) {
					this.worker = undefined;
				}
				resolve(result);
			};
			worker = new Worker(vscode.Uri.joinPath(this.extensionUri, 'media', 'java-runtime-worker.js').toString(), {
				name: 'webprocessing-java-test-runtime'
			});
			this.worker = worker;
			worker.onmessage = event => {
				const message = event.data as JavaRuntimeMessage;
				switch (message.type) {
					case 'stdout':
						stdout += message.text ?? '';
						break;
					case 'stderr':
						stderr += message.text ?? '';
						break;
					case 'log':
						stderr += `${message.text ?? ''}\n`;
						break;
					case 'finished':
						finish({ stdout, stderr });
						break;
					case 'error':
						finish({ stdout, stderr, error: message.text ?? 'Runtime failed.' });
						break;
				}
			};
			worker.onerror = event => finish({ stdout, stderr, error: event.message });
			worker.postMessage({
				type: 'run',
				runtimeUri: this.runtimeUri(),
				wasmBytes,
				input,
				capture: true
			}, [wasmBytes.buffer]);
		});
	}

	stop(log = true): void {
		if (!this.worker) {
			return;
		}
		this.runId++;
		this.worker.terminate();
		this.worker = undefined;
		if (log) {
			this.showOutput();
			this.log('[runtime] Runtime stopped.');
		}
	}

	private handleMessage(runId: number, message: JavaRuntimeMessage): void {
		if (runId !== this.runId) {
			return;
		}
		switch (message.type) {
			case 'stdout':
			case 'stderr':
				this.showOutput();
				this.appendOutput(message.text ?? '');
				break;
			case 'log':
				this.showOutput();
				this.log(`${message.text ?? ''}`);
				break;
			case 'finished':
				this.showOutput();
				this.log('[runtime] Runtime finished.');
				this.stop(false);
				this.setRunning(false);
				void this.refreshState();
				break;
			case 'error':
				this.showOutput();
				this.log(`[runtime] ${message.text ?? 'Runtime failed.'}`);
				this.stop(false);
				this.setRunning(false);
				void this.refreshState();
				void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
				break;
		}
	}
}
