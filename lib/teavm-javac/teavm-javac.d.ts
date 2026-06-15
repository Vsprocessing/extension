export type BinaryInput = string | URL | ArrayBuffer | ArrayBufferView | Int8Array;
export type TeaVMOptimizationLevel = "simple" | "advanced" | "full" | "SIMPLE" | "ADVANCED" | "FULL";
export type CompilerBackend = "auto" | "js" | "javascript" | "wasm" | "wasm-gc" | "wasmgc";
export type JavaProgramStdin = string;
export type JavaProgramOutput = (text: string) => void;
export interface JavaProgramStdioOptions {
    stdin?: JavaProgramStdin;
    stdout?: JavaProgramOutput;
    stderr?: JavaProgramOutput;
}
export interface JavaProgramFileSystemCallbacks {
    onFileWrite?: (path: string, content: Uint8Array) => void;
    onFileClose?: (path: string, mode: string, content: Uint8Array | null) => void;
}
export type JavaProgramFileOpenPath = (path: string, mode?: string) => Uint8Array | Promise<Uint8Array>;
export type JavaProgramFileSystemOptions = false | JavaProgramFileSystemCallbacks;
export type JavaProgramConsoleOptions = false | JavaProgramStdioOptions;
export interface JavaProgramOptions {
    stdio?: JavaProgramConsoleOptions;
    fs?: JavaProgramFileSystemOptions;
    installImports?: (imports: Record<string, unknown>, controller?: unknown) => void;
    wasmRuntime?: string | URL;
    wasmRuntimeUrl?: string | URL;
    runtimeModule?: {
        load(wasmBytes: BinaryInput, options?: Record<string, unknown>): Promise<unknown>;
    };
    wasmRuntimeOptions?: Record<string, unknown>;
    runtimeOptions?: Record<string, unknown>;
    [name: string]: unknown;
}
export interface CompilerClasslibOptions {
    javac?: BinaryInput;
    runtime?: BinaryInput;
}
export interface CompilerRuntimeExports {
    createCompiler(): unknown;
    installWorker(): void;
    [name: string]: unknown;
}
export interface CompilerRuntime {
    exports: CompilerRuntimeExports;
    backend?: "js" | "wasm-gc" | string;
    source?: string | URL | null;
    instance?: unknown;
    module?: unknown;
    diagnostics?: CompilerDiagnostic[];
}
export interface CompilerRuntimeLoadOptions {
    backend?: CompilerBackend;
    compilerBackend?: CompilerBackend;
    runtimeBackend?: CompilerBackend;
    compilerJs?: string | URL | CompilerRuntime | CompilerRuntimeExports;
    compilerJsUrl?: string | URL;
    compilerRuntime?: CompilerRuntime | CompilerRuntimeExports;
    compilerWasm?: BinaryInput;
    compilerWasmUrl?: BinaryInput;
    compilerWasmRuntime?: string | URL;
    compilerWasmRuntimeUrl?: string | URL;
    wasmRuntime?: string | URL;
    wasmRuntimeUrl?: string | URL;
    wasmRuntimeOptions?: Record<string, unknown>;
    runtimeOptions?: Record<string, unknown>;
    stdio?: JavaProgramConsoleOptions;
    fs?: JavaProgramFileSystemOptions;
    fallbackToJs?: boolean;
}
export interface CreateCompilerOptions extends CompilerRuntimeLoadOptions {
    javacClasslib?: BinaryInput;
    javacClasslibUrl?: BinaryInput;
    runtimeClasslib?: BinaryInput;
    runtimeClasslibUrl?: BinaryInput;
    loadClasslib?: boolean;
}
export interface CompilerFileSet {
    list(): string[];
    get(path: string): Int8Array | null;
    archive(): Int8Array;
    text(path: string): string | null;
}
export interface CompilerDiagnostic {
    type?: string;
    severity?: string;
    fileName?: string | null;
    lineNumber?: number;
    columnNumber?: number;
    message?: string;
}
export interface DiagnosticRegistration {
    unsubscribe(): void;
    dispose(): void;
    raw: unknown;
}
export interface ProcessingSource {
    path?: string;
    name?: string;
    content: string;
}
export interface ProcessingSourceTab {
    path: string;
    charStart: number;
    lineStart: number;
    lineCount: number;
}
export interface ProcessingEdit {
    fromOffset: number;
    fromLength: number;
    toOffset: number;
    toLength: number;
    text: string | null;
}
export interface ProcessingIssue {
    line: number;
    column: number;
    message: string;
}
export interface ProcessingPreprocessOptions {
    sketchName?: string;
    className?: string;
    name?: string;
}
export interface ProcessingPreprocessResult {
    ok: boolean;
    sourceFileName: string;
    className: string;
    javaSource: string;
    programType: "STATIC" | "ACTIVE" | "JAVA" | string;
    lineOffset: number;
    sketchWidth: string | null;
    sketchHeight: string | null;
    sketchRenderer: string | null;
    tabs: ProcessingSourceTab[];
    edits: ProcessingEdit[];
    issues: ProcessingIssue[];
    raw: unknown;
}
export interface EmitWasmOptions {
    name?: string;
    outputName?: string;
    mainClass: string;
    optimizationLevel?: TeaVMOptimizationLevel;
    optimization?: TeaVMOptimizationLevel;
    fastGlobalAnalysis?: boolean;
    fastDependencyAnalysis?: boolean;
    runtimeModule?: boolean;
}
export interface EmitWasmResult {
    ok: boolean;
    fileName: string;
    bytes: Int8Array | null;
    files: string[];
}
export interface EmitJsOptions {
    name?: string;
    outputName?: string;
    fileName?: string;
    mainClass: string;
    module?: "umd" | "esm" | "commonjs" | "script" | string;
    moduleType?: string;
    sourceMap?: boolean;
    sourceMaps?: boolean;
    sourceMapName?: string;
    optimizationLevel?: TeaVMOptimizationLevel;
    optimization?: TeaVMOptimizationLevel;
    fastGlobalAnalysis?: boolean;
    fastDependencyAnalysis?: boolean;
}
export interface EmitJsResult {
    ok: boolean;
    fileName: string;
    bytes: Int8Array | null;
    text: string | null;
    sourceMapName: string;
    sourceMapBytes: Int8Array | null;
    sourceMapText: string | null;
    files: string[];
}
export declare function createCompiler(options?: CreateCompilerOptions): Promise<JavaCompiler>;
export declare function installWorker(options?: CompilerRuntimeLoadOptions): Promise<CompilerRuntime>;
export declare function loadCompilerRuntime(input?: string | URL | CompilerRuntime | CompilerRuntimeExports | CompilerRuntimeLoadOptions): Promise<CompilerRuntime>;
export declare const loadRuntime: typeof loadCompilerRuntime;
export declare function createJavaProgramOptions(options?: JavaProgramOptions, openFilePath?: JavaProgramFileOpenPath): JavaProgramOptions;
export declare function createJavaProgram(wasmBytes: BinaryInput, options?: JavaProgramOptions): Promise<JavaProgram>;
export declare function setActiveProgram(program: any): any;
export declare class JavaProgram {
    readonly wasmProgram: any;
    readonly options: JavaProgramOptions;
    constructor(wasmProgram: any, options?: JavaProgramOptions);
    get exports(): any;
    get instance(): any;
    get module(): any;
    execute(argsOrOptions?: string[] | {
        args?: string[];
        onFinish?: (result: {
            program: JavaProgram;
        }) => void;
        timeoutMs?: number;
    }): Promise<{
        program: JavaProgram;
    }>;
}
export declare function supportsCompilerWasmGC(): Promise<boolean>;
export declare function getCompilerWasmGCSupport(): Promise<{
    supported: boolean;
    reason: string | null;
}>;
export declare class JavaCompiler {
    readonly raw: any;
    readonly runtime: CompilerRuntime;
    readonly startupDiagnostics: CompilerDiagnostic[];
    readonly classes: CompilerFileSet;
    readonly wasm: CompilerFileSet;
    readonly js: CompilerFileSet;
    constructor(raw: any, runtime: any);
    setClasslib({ javac, runtime }: CompilerClasslibOptions): Promise<this>;
    addSource(path: string, content: string): this;
    clearSources(): this;
    preprocessProcessing(sources: Array<string | ProcessingSource>, options?: ProcessingPreprocessOptions): ProcessingPreprocessResult;
    addDependency(path: string, bytes: BinaryInput): this;
    addDependencyArchive(bytes: BinaryInput): this;
    clearDependencies(): this;
    addClassFile(path: string, bytes: BinaryInput): this;
    addClassArchive(bytes: BinaryInput): this;
    clearClassFiles(): this;
    onDiagnostic(listener: (diagnostic: CompilerDiagnostic) => void): DiagnosticRegistration;
    compile(): boolean;
    findMainClasses(): string[];
    emitWasm(options: EmitWasmOptions): EmitWasmResult;
    emitJs(options: EmitJsOptions): EmitJsResult;
}
export declare function installJavaRuntimeStdio(imports: any, options?: {}): void;
export declare function installJavaRuntimeFileSystem(imports: any, options?: JavaProgramFileSystemCallbacks, openFilePath?: JavaProgramFileOpenPath): void;
export declare function fetchFilePath(path: any): Promise<Uint8Array<ArrayBuffer>>;
export declare function createFileNotFoundError(path: any): Error;
export declare function normalizeStorePath(path: any): string;
export declare function decodeFileBytes(value: any): string;
export declare function decodedImageByToken(token: any): any;
