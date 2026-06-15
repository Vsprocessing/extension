export type CheckKind = "validator" | "compiles";
export interface BaseCheck {
    id: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    timeoutMs?: number;
}
export interface ValidatorCheck extends BaseCheck {
    type: "validator";
    mainClass: string;
    /**
     * Java source files keyed by relative path, e.g. {"HiddenValidator.java": "..."}.
     * CSPT stores these; an external grader decides how to compile/run them.
     */
    files: Record<string, string>;
    args?: string[];
    classpath?: string[];
}
export interface CompileCheck extends BaseCheck {
    type: "compiles";
    /**
     * Optional metadata for the external grader. CSPT does not execute compilers.
     */
    sourceGlobs?: string[];
    args?: string[];
}
export type AssignmentCheck = ValidatorCheck | CompileCheck;
export interface BundleInput {
    id: string;
    displayName: string;
    description: string;
    templateDir: string;
    checks: AssignmentCheck[];
}
export interface BundleOptions {
}
export interface BundlePayload {
    id: string;
    displayName: string;
    description: string;
    templateZipBase64: string;
    checks: AssignmentCheck[];
    createdAt: string;
}
export interface TemplateFile {
    path: string;
    bytes: Uint8Array;
}
