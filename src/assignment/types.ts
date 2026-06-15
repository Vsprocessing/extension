import * as vscode from 'vscode';

export type AssignmentCheck = ValidatorCheck | CompileCheck;

export interface BaseCheck {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly hidden?: boolean;
	readonly timeoutMs?: number;
}

export interface ValidatorCheck extends BaseCheck {
	readonly type: 'validator';
	readonly mainClass: string;
	readonly files: Record<string, string>;
	readonly args?: readonly string[];
	readonly classpath?: readonly string[];
}

export interface CompileCheck extends BaseCheck {
	readonly type: 'compiles';
	readonly sourceGlobs?: readonly string[];
	readonly args?: readonly string[];
}

export interface CsptAssignment {
	readonly uri: vscode.Uri;
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly checks: readonly AssignmentCheck[];
}

export interface CsptAssignmentData {
	readonly id: string;
	readonly displayName: string;
	readonly bundleUri: string;
	readonly startedAt: string;
	readonly results?: readonly CsptCheckResult[];
	readonly evaluatedAt?: string;
}

export interface CsptCheckResult {
	readonly id: string;
	readonly type: CompileCheck['type'] | ValidatorCheck['type'];
	readonly displayName: string;
	readonly description?: string;
	readonly hidden: boolean;
	readonly passed: boolean;
	readonly evaluatedAt: string;
	readonly reason?: string;
}

export interface AssignmentViewState {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly started: boolean;
	readonly preview: boolean;
	readonly hasWorkspace: boolean;
	readonly running: boolean;
	readonly results: readonly AssignmentViewCheck[];
	readonly message: string;
}

export interface AssignmentViewCheck {
	readonly id: string;
	readonly displayName: string;
	readonly description?: string;
	readonly passed?: boolean;
	readonly evaluatedAt?: string;
	readonly reason?: string;
}
