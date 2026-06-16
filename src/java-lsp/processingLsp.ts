import * as vscode from 'vscode';
import { load as loadJdt } from 'eclipse-jdt-ls-web';
import type { WebJdtLsApi } from 'eclipse-jdt-ls-web';
import { loadCsptAssignment, readAssignmentData } from '../assignment/assignmentLoader';
import type { ValidatorCheck } from '../assignment/types';
import { collectSources, identifyEntrypoint, isInWorkspaceFolder, isJavaUri, isProcessingUri, type WorkspaceSource } from '../utils';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

interface LspPosition {
	readonly line: number;
	readonly character: number;
}

interface LspDiagnostic {
	readonly range: {
		readonly start: LspPosition;
		readonly end: LspPosition;
	};
	readonly severity?: number;
	readonly source?: string;
	readonly code?: number | string;
	readonly message: string;
}

interface MappedLspDiagnostic extends LspDiagnostic {
	readonly uri?: string;
}

interface PublishDiagnosticsMessage {
	readonly method?: string;
	readonly params?: {
		readonly uri?: string;
		readonly diagnostics?: readonly LspDiagnostic[];
	};
}

interface LspTextEdit {
	readonly range: {
		readonly start: LspPosition;
		readonly end: LspPosition;
	};
	readonly newText: string;
}

interface LspMarkupContent {
	readonly kind?: string;
	readonly value?: string;
}

interface LspCompletionItem {
	readonly label: string;
	readonly kind?: number;
	readonly detail?: string;
	readonly documentation?: string | LspMarkupContent;
	readonly sortText?: string;
	readonly filterText?: string;
	readonly insertText?: string;
	readonly insertTextFormat?: number;
	readonly textEdit?: LspTextEdit;
	readonly additionalTextEdits?: readonly LspTextEdit[];
	readonly commitCharacters?: readonly string[];
	readonly preselect?: boolean;
}

interface LspCompletionList {
	readonly isIncomplete?: boolean;
	readonly items?: readonly LspCompletionItem[];
}

interface LspResponse<T> {
	readonly result?: T | null;
	readonly error?: {
		readonly code?: number;
		readonly message?: string;
	};
}

type LspHoverContent = string | LspMarkupContent;

interface LspHover {
	readonly contents?: LspHoverContent | readonly LspHoverContent[];
	readonly range?: LspTextEdit['range'];
}

interface LspParameterInformation {
	readonly label: string | readonly [number, number];
	readonly documentation?: string | LspMarkupContent;
}

interface LspSignatureInformation {
	readonly label: string;
	readonly documentation?: string | LspMarkupContent;
	readonly parameters?: readonly LspParameterInformation[];
	readonly activeParameter?: number;
}

interface LspSignatureHelp {
	readonly signatures?: readonly LspSignatureInformation[];
	readonly activeSignature?: number;
	readonly activeParameter?: number;
}

export class ProcessingLinter implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('webprocessing');
	private jdtWasm: Promise<WebJdtLsApi> | undefined;
	private lintTimer: unknown;
	private linting = false;
	private pendingJava = false;
	private pendingProcessing = false;
	private readonly javaUris = new Set<string>();
	private readonly javaJdtUris = new Map<string, string>();
	private readonly processingUris = new Set<string>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(this.diagnostics);
		this.disposables.push(vscode.workspace.onDidOpenTextDocument(document => this.scheduleDocument(document)));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => this.scheduleDocument(event.document)));
		this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => this.scheduleDocument(document)));
		this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.clearClosedDocument(document)));
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleAll()));
		this.disposables.push(vscode.workspace.onDidCreateFiles(() => this.scheduleAll()));
		this.disposables.push(vscode.workspace.onDidDeleteFiles(() => this.scheduleAll()));
		this.disposables.push(vscode.workspace.onDidRenameFiles(() => this.scheduleAll()));
		this.disposables.push(vscode.languages.registerCompletionItemProvider(
			{ language: 'java', scheme: '*' },
			{ provideCompletionItems: (document, position) => this.provideCompletionItems(document, position) },
			'.',
			'@'
		));
		this.disposables.push(vscode.languages.registerHoverProvider(
			{ language: 'java', scheme: '*' },
			{ provideHover: (document, position) => this.provideHover(document, position) }
		));
		this.disposables.push(vscode.languages.registerSignatureHelpProvider(
			{ language: 'java', scheme: '*' },
			{ provideSignatureHelp: (document, position, _token, context) => this.provideSignatureHelp(document, position, context) },
			{ triggerCharacters: ['(', ','], retriggerCharacters: [','] }
		));
		this.scheduleAll();
	}

	dispose(): void {
		if (this.lintTimer) {
			clearTimeout(this.lintTimer);
			this.lintTimer = undefined;
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private scheduleDocument(document: vscode.TextDocument): void {
		if (isJavaUri(document.uri)) {
			this.scheduleJava();
		} else if (isProcessingUri(document.uri)) {
			this.scheduleProcessing();
		}
	}

	private clearClosedDocument(document: vscode.TextDocument): void {
		if (!isJavaUri(document.uri) && !isProcessingUri(document.uri)) {
			return;
		}
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			this.diagnostics.delete(document.uri);
		}
	}

	private scheduleAll(): void {
		this.pendingJava = true;
		this.pendingProcessing = true;
		this.schedule();
	}

	private scheduleJava(): void {
		this.pendingJava = true;
		this.schedule();
	}

	private scheduleProcessing(): void {
		this.pendingProcessing = true;
		this.schedule();
	}

	private schedule(): void {
		if (this.lintTimer) {
			clearTimeout(this.lintTimer);
		}
		this.lintTimer = setTimeout(() => {
			this.lintTimer = undefined;
			void this.runPendingLint();
		}, 250);
	}

	private async runPendingLint(): Promise<void> {
		if (this.linting) {
			this.schedule();
			return;
		}

		const lintJava = this.pendingJava;
		const lintProcessing = this.pendingProcessing;
		this.pendingJava = false;
		this.pendingProcessing = false;
		this.linting = true;

		try {
			if (lintJava) {
				await this.lintJava();
			}
			if (lintProcessing) {
				await this.lintProcessing();
			}
		} catch (error) {
			console.error(error);
		} finally {
			this.linting = false;
			if (this.pendingJava || this.pendingProcessing) {
				this.schedule();
			}
		}
	}

	private async lintJava(): Promise<void> {
		const sources = await this.collectJavaWorkspaceSources();
		const currentUris = new Set(sources.map(source => source.uri.toString()));
		const sourceByJdtUri = new Map<string, string>();
		let lastMessages: readonly PublishDiagnosticsMessage[] = [];
		const jdt = sources.length > 0 || this.javaUris.size > 0 ? await this.loadJdtWasm() : undefined;

		for (const uri of this.javaUris) {
			if (jdt && !currentUris.has(uri)) {
				lastMessages = this.parseMessages(jdt.handle(JSON.stringify({
					jsonrpc: '2.0',
					method: 'java/browserJdtLs/removeWorkspaceSource',
					params: { uri: this.javaJdtUris.get(uri) ?? uri }
				})));
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		}
		if (!jdt) {
			return;
		}

		for (const source of sources) {
			const jdtUri = this.jdtSourceUri(source);
			sourceByJdtUri.set(jdtUri, source.uri.toString());
			lastMessages = this.parseMessages(jdt.handle(JSON.stringify({
				jsonrpc: '2.0',
				method: 'java/browserJdtLs/workspaceSources',
				params: {
					uri: jdtUri,
					text: source.content
				}
			})));
		}

		if (sources.length === 0) {
			for (const uri of this.javaUris) {
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		} else {
			this.applyPublishDiagnostics(lastMessages, sourceByJdtUri);
		}
		this.javaUris.clear();
		this.javaJdtUris.clear();
		for (const uri of currentUris) {
			this.javaUris.add(uri);
		}
		for (const source of sources) {
			this.javaJdtUris.set(source.uri.toString(), this.jdtSourceUri(source));
		}
	}

	private async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionList | undefined> {
		if (!this.supportsDocument(document)) {
			return undefined;
		}
		const result = await this.requestJdt<LspCompletionList | readonly LspCompletionItem[]>(document, 'textDocument/completion', position);
		return result ? this.toCompletionList(result) : undefined;
	}

	private async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		if (!this.supportsDocument(document)) {
			return undefined;
		}
		const result = await this.requestJdt<LspHover>(document, 'textDocument/hover', position);
		return result ? this.toHover(result) : undefined;
	}

	private async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, context: vscode.SignatureHelpContext): Promise<vscode.SignatureHelp | undefined> {
		if (!this.supportsDocument(document)) {
			return undefined;
		}
		const result = await this.requestJdt<LspSignatureHelp>(document, 'textDocument/signatureHelp', position, {
			context: {
				triggerKind: context.triggerKind,
				triggerCharacter: context.triggerCharacter
			}
		});
		return result ? this.toSignatureHelp(result) : undefined;
	}

	private async lintProcessing(): Promise<void> {
		const currentUris = new Set<string>();
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const sources = workspaceFolder
			? await this.collectProcessingWorkspaceSources(workspaceFolder)
			: [...(await collectSources('processing')).sources];

		for (const source of sources) {
			currentUris.add(source.uri.toString());
		}

		if (sources.length > 0) {
			const entrypoint = identifyEntrypoint(sources, workspaceFolder);
			if (!entrypoint && sources.length > 1) {
				this.setEntrypointDiagnostics(workspaceFolder, sources);
			} else {
				const mainSource = entrypoint ? sources.find(source => source.path === entrypoint.path) ?? sources[0] : sources[0];
				const additionalSources = sources
					.filter(source => source.uri.toString() !== mainSource.uri.toString())
					.map(source => ({ uri: source.uri.toString(), text: source.content }));
				const jdt = await this.loadJdtWasm();
				const diagnostics = this.parseDiagnostics(jdt.lintProcessing(mainSource.uri.toString(), mainSource.content, JSON.stringify({ sources: additionalSources })));
				this.setMappedDiagnostics(sources, diagnostics);
			}
		}

		for (const uri of this.processingUris) {
			if (!currentUris.has(uri)) {
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		}
		this.processingUris.clear();
		for (const uri of currentUris) {
			this.processingUris.add(uri);
		}
	}

	private async collectJavaWorkspaceSources(): Promise<WorkspaceSource[]> {
		const sources = [...(await collectSources('java')).sources];
		sources.push(...await this.collectAssignmentClasspathSources());

		for (const document of vscode.workspace.textDocuments) {
			if (!isJavaUri(document.uri)) {
				continue;
			}
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!workspaceFolder) {
				continue;
			}
			this.upsertSource(sources, {
				uri: document.uri,
				path: document.uri.path.split('/').pop() ?? document.uri.path,
				content: document.getText()
			});
		}

		return sources;
	}

	private async collectAssignmentClasspathSources(): Promise<WorkspaceSource[]> {
		const result: WorkspaceSource[] = [];
		const seen = new Set<string>();
		for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
			const assignment = await this.workspaceAssignment(workspaceFolder);
			if (!assignment) {
				continue;
			}
			for (const check of assignment.checks) {
				if (check.type !== 'validator') {
					continue;
				}
				for (const source of this.validatorClasspathSources(assignment.id, check)) {
					const key = source.path;
					if (!seen.has(key)) {
						seen.add(key);
						result.push(source);
					}
				}
			}
		}
		return result;
	}

	private async workspaceAssignment(workspaceFolder: vscode.WorkspaceFolder) {
		const data = await readAssignmentData(workspaceFolder);
		if (!data?.bundleUri) {
			return undefined;
		}
		try {
			return await loadCsptAssignment(this.context.extensionUri, vscode.Uri.parse(data.bundleUri));
		} catch {
			return undefined;
		}
	}

	private validatorClasspathSources(assignmentId: string, check: ValidatorCheck): WorkspaceSource[] {
		const result: WorkspaceSource[] = [];
		for (const rawPath of check.classpath ?? []) {
			const path = this.normalizedClasspathPath(rawPath);
			if (!path || !path.toLowerCase().endsWith('.java')) {
				continue;
			}
			const content = check.files[path] ?? check.files[rawPath];
			if (content === undefined) {
				continue;
			}
			result.push({
				uri: vscode.Uri.from({ scheme: 'cspt-classpath', path: `/${assignmentId}/${path}` }),
				path,
				content
			});
		}
		return result;
	}

	private normalizedClasspathPath(path: string): string | undefined {
		const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
		if (!normalized || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
			return undefined;
		}
		return normalized;
	}

	private async collectProcessingWorkspaceSources(workspaceFolder: vscode.WorkspaceFolder): Promise<WorkspaceSource[]> {
		const sources = [...(await collectSources('processing')).sources].filter(source => isInWorkspaceFolder(source.uri, workspaceFolder));

		for (const document of vscode.workspace.textDocuments) {
			if (isProcessingUri(document.uri) && isInWorkspaceFolder(document.uri, workspaceFolder)) {
				this.upsertSource(sources, {
					uri: document.uri,
					path: this.relativePath(document.uri, workspaceFolder),
					content: document.getText()
				});
			}
		}

		return sources;
	}

	private upsertSource(sources: WorkspaceSource[], source: WorkspaceSource): void {
		const uri = source.uri.toString();
		const index = sources.findIndex(candidate => candidate.uri.toString() === uri);
		if (index >= 0) {
			sources[index] = source;
		} else {
			sources.push(source);
		}
	}

	private relativePath(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
		const folderPath = workspaceFolder.uri.path.endsWith('/') ? workspaceFolder.uri.path : `${workspaceFolder.uri.path}/`;
		return uri.path.startsWith(folderPath) ? uri.path.slice(folderPath.length) : uri.path.split('/').pop() ?? uri.path;
	}

	private setEntrypointDiagnostics(workspaceFolder: vscode.WorkspaceFolder | undefined, sources: readonly WorkspaceSource[]): void {
		const message = workspaceFolder
			? `Cannot determine Processing entrypoint for a multi-file project. Put the sketch entrypoint in ${workspaceFolder.name}.pde or main.pde.`
			: 'Cannot determine Processing entrypoint for open tabs. Put the sketch entrypoint in main.pde.';
		for (const source of sources) {
			const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, vscode.DiagnosticSeverity.Error);
			diagnostic.source = 'Processing';
			this.diagnostics.set(source.uri, [diagnostic]);
		}
	}

	private setMappedDiagnostics(sources: readonly WorkspaceSource[], diagnostics: readonly MappedLspDiagnostic[]): void {
		const grouped = new Map<string, vscode.Diagnostic[]>();
		for (const source of sources) {
			grouped.set(source.uri.toString(), []);
		}
		for (const diagnostic of diagnostics) {
			if (!diagnostic.uri) {
				continue;
			}
			const uriDiagnostics = grouped.get(diagnostic.uri) ?? [];
			uriDiagnostics.push(this.toDiagnostic(diagnostic));
			grouped.set(diagnostic.uri, uriDiagnostics);
		}
		for (const [uri, uriDiagnostics] of grouped) {
			this.diagnostics.set(vscode.Uri.parse(uri), uriDiagnostics);
		}
	}

	private applyPublishDiagnostics(messages: readonly PublishDiagnosticsMessage[], uriMap?: ReadonlyMap<string, string>): void {
		for (const message of messages) {
			if (message.method !== 'textDocument/publishDiagnostics' || !message.params?.uri) {
				continue;
			}
			const uri = uriMap?.get(message.params.uri) ?? message.params.uri;
			this.diagnostics.set(vscode.Uri.parse(uri), (message.params.diagnostics ?? []).map(diagnostic => this.toDiagnostic(diagnostic)));
		}
	}

	private jdtSourceUri(source: WorkspaceSource): string {
		return vscode.workspace.getWorkspaceFolder(source.uri) ? source.uri.toString() : source.path;
	}

	private jdtDocumentUri(document: vscode.TextDocument): string {
		return vscode.workspace.getWorkspaceFolder(document.uri) ? document.uri.toString() : document.fileName;
	}

	private supportsDocument(document: vscode.TextDocument): boolean {
		return isJavaUri(document.uri) || isProcessingUri(document.uri);
	}

	private async requestJdt<T>(document: vscode.TextDocument, method: string, position: vscode.Position, params?: object): Promise<T | undefined> {
		const jdt = await this.loadJdtWasm();
		const uri = this.jdtDocumentUri(document);
		for (const source of await this.collectJavaWorkspaceSources()) {
			const sourceUri = this.jdtSourceUri(source);
			jdt.handle(JSON.stringify({
				jsonrpc: '2.0',
				method: 'java/browserJdtLs/workspaceSources',
				params: {
					uri: sourceUri,
					text: source.content
				}
			}));
		}
		jdt.handle(JSON.stringify({
			jsonrpc: '2.0',
			method: 'java/browserJdtLs/workspaceSources',
			params: {
				uri,
				text: document.getText()
			}
		}));
		const response = this.parseResponse<T>(jdt.handle(JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method,
			params: {
				textDocument: { uri },
				position: {
					line: position.line,
					character: position.character
				},
				...params
			}
		})));
		return response?.result ?? undefined;
	}

	private toDiagnostic(diagnostic: LspDiagnostic): vscode.Diagnostic {
		const result = new vscode.Diagnostic(
			new vscode.Range(
				diagnostic.range.start.line,
				diagnostic.range.start.character,
				diagnostic.range.end.line,
				diagnostic.range.end.character
			),
			diagnostic.message,
			this.toSeverity(diagnostic.severity)
		);
		result.source = diagnostic.source ?? 'Java';
		result.code = diagnostic.code;
		return result;
	}

	private toSeverity(severity: number | undefined): vscode.DiagnosticSeverity {
		switch (severity) {
			case 2:
				return vscode.DiagnosticSeverity.Warning;
			case 3:
				return vscode.DiagnosticSeverity.Information;
			case 4:
				return vscode.DiagnosticSeverity.Hint;
			default:
				return vscode.DiagnosticSeverity.Error;
		}
	}

	private toCompletionList(value: LspCompletionList | readonly LspCompletionItem[]): vscode.CompletionList {
		const parsed = value as unknown;
		if (Array.isArray(parsed)) {
			return new vscode.CompletionList((parsed as LspCompletionItem[]).map(item => this.toCompletionItem(item)));
		}
		const list = value as LspCompletionList;
		const items = list.items ?? [];
		return new vscode.CompletionList(items.map(item => this.toCompletionItem(item)), !!list.isIncomplete);
	}

	private toCompletionItem(item: LspCompletionItem): vscode.CompletionItem {
		const result = new vscode.CompletionItem(item.label, this.toCompletionKind(item.kind));
		result.detail = item.detail;
		result.documentation = this.toCompletionDocumentation(item.documentation);
		result.sortText = item.sortText;
		result.filterText = item.filterText;
		result.commitCharacters = item.commitCharacters ? [...item.commitCharacters] : undefined;
		result.preselect = item.preselect;
		if (item.textEdit) {
			result.textEdit = new vscode.TextEdit(this.toRange(item.textEdit.range), item.textEdit.newText);
		} else if (item.insertText) {
			result.insertText = item.insertTextFormat === 2 ? new vscode.SnippetString(item.insertText) : item.insertText;
		}
		if (item.additionalTextEdits) {
			result.additionalTextEdits = item.additionalTextEdits.map(edit => new vscode.TextEdit(this.toRange(edit.range), edit.newText));
		}
		return result;
	}

	private toCompletionDocumentation(documentation: string | LspMarkupContent | undefined): string | vscode.MarkdownString | undefined {
		if (!documentation || typeof documentation === 'string') {
			return documentation;
		}
		if (documentation.kind === 'markdown') {
			return new vscode.MarkdownString(documentation.value ?? '');
		}
		return documentation.value;
	}

	private toHover(hover: LspHover): vscode.Hover | undefined {
		if (!hover.contents) {
			return undefined;
		}
		const contents = (Array.isArray(hover.contents) ? hover.contents : [hover.contents])
			.map(content => this.toMarkdown(content))
			.filter(content => content.value.length > 0);
		return contents.length ? new vscode.Hover(contents, hover.range ? this.toRange(hover.range) : undefined) : undefined;
	}

	private toSignatureHelp(signatureHelp: LspSignatureHelp): vscode.SignatureHelp | undefined {
		const signatures = signatureHelp.signatures ?? [];
		if (!signatures.length) {
			return undefined;
		}
		const result = new vscode.SignatureHelp();
		result.signatures = signatures.map(signature => this.toSignatureInformation(signature));
		result.activeSignature = signatureHelp.activeSignature ?? 0;
		result.activeParameter = signatureHelp.activeParameter ?? 0;
		return result;
	}

	private toSignatureInformation(signature: LspSignatureInformation): vscode.SignatureInformation {
		const result = new vscode.SignatureInformation(signature.label, this.toDocumentation(signature.documentation));
		result.parameters = (signature.parameters ?? []).map(parameter => new vscode.ParameterInformation(
			this.toParameterLabel(parameter.label),
			this.toDocumentation(parameter.documentation)
		));
		result.activeParameter = signature.activeParameter;
		return result;
	}

	private toParameterLabel(label: string | readonly [number, number]): string | [number, number] {
		const value = label as unknown;
		return Array.isArray(value) ? [value[0], value[1]] : label as string;
	}

	private toDocumentation(documentation: string | LspMarkupContent | undefined): string | vscode.MarkdownString | undefined {
		if (!documentation || typeof documentation === 'string') {
			return documentation;
		}
		return this.toMarkdown(documentation);
	}

	private toMarkdown(content: LspHoverContent): vscode.MarkdownString {
		if (typeof content === 'string') {
			return new vscode.MarkdownString(content);
		}
		const markdown = new vscode.MarkdownString(content.value ?? '');
		markdown.supportHtml = content.kind !== 'plaintext';
		return markdown;
	}

	private toCompletionKind(kind: number | undefined): vscode.CompletionItemKind | undefined {
		switch (kind) {
			case 1: return vscode.CompletionItemKind.Text;
			case 2: return vscode.CompletionItemKind.Method;
			case 3: return vscode.CompletionItemKind.Function;
			case 4: return vscode.CompletionItemKind.Constructor;
			case 5: return vscode.CompletionItemKind.Field;
			case 6: return vscode.CompletionItemKind.Variable;
			case 7: return vscode.CompletionItemKind.Class;
			case 8: return vscode.CompletionItemKind.Interface;
			case 9: return vscode.CompletionItemKind.Module;
			case 10: return vscode.CompletionItemKind.Property;
			case 11: return vscode.CompletionItemKind.Unit;
			case 12: return vscode.CompletionItemKind.Value;
			case 13: return vscode.CompletionItemKind.Enum;
			case 14: return vscode.CompletionItemKind.Keyword;
			case 15: return vscode.CompletionItemKind.Snippet;
			case 16: return vscode.CompletionItemKind.Color;
			case 17: return vscode.CompletionItemKind.File;
			case 18: return vscode.CompletionItemKind.Reference;
			case 19: return vscode.CompletionItemKind.Folder;
			case 20: return vscode.CompletionItemKind.EnumMember;
			case 21: return vscode.CompletionItemKind.Constant;
			case 22: return vscode.CompletionItemKind.Struct;
			case 23: return vscode.CompletionItemKind.Event;
			case 24: return vscode.CompletionItemKind.Operator;
			case 25: return vscode.CompletionItemKind.TypeParameter;
			default: return undefined;
		}
	}

	private toRange(range: LspTextEdit['range']): vscode.Range {
		return new vscode.Range(
			range.start.line,
			range.start.character,
			range.end.line,
			range.end.character
		);
	}

	private parseDiagnostics(payload: string): readonly MappedLspDiagnostic[] {
		if (!payload) {
			return [];
		}
		const parsed = JSON.parse(payload);
		return Array.isArray(parsed) ? parsed : [];
	}

	private parseMessages(payload: string): readonly PublishDiagnosticsMessage[] {
		if (!payload) {
			return [];
		}
		const parsed = JSON.parse(payload);
		return Array.isArray(parsed) ? parsed : [parsed];
	}

	private parseResponse<T>(payload: string): LspResponse<T> | undefined {
		if (!payload) {
			return undefined;
		}
		const response = JSON.parse(payload) as LspResponse<T>;
		if (response.error) {
			throw new Error(response.error.message ?? `Language server request failed: ${response.error.code ?? 'unknown error'}`);
		}
		return response;
	}

	private async loadJdtWasm(): Promise<WebJdtLsApi> {
		if (!this.jdtWasm) {
			this.jdtWasm = this.doLoadJdtWasm();
		}
		return this.jdtWasm;
	}

	private async doLoadJdtWasm(): Promise<WebJdtLsApi> {
		return loadJdt({ baseUrl: this.jdtBaseUri().toString() });
	}

	private jdtBaseUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'eclipse-jdt-ls-web');
	}
}
