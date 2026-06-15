import type { BinaryInput, CreateCompilerOptions, JavaCompiler, JavaProgramConsoleOptions, JavaProgramFileSystemOptions, JavaProgramOptions, ProcessingPreprocessResult, ProcessingSource, TeaVMOptimizationLevel } from "./teavm-javac.js";
export type ProcessingSketchBackend = "p5" | "p5js" | "canvas" | "canvas2d" | "direct-canvas" | "direct-canvas2d";
export type ProcessingOutputTarget = "auto" | "best" | "default" | "js" | "javascript" | "esm" | "wasm" | "webassembly" | "wasm-gc" | "wasmgc";
export interface ProcessingRunOptions {
    root?: ParentNode;
    selector?: string;
    target?: ProcessingOutputTarget | string;
    output?: ProcessingOutputTarget | string;
    baseUrl?: string | URL;
    backend?: ProcessingSketchBackend;
    renderer?: ProcessingSketchBackend;
    p5?: P5Constructor;
    canvas2d?: Canvas2DBackendOptions;
    canvasOptions?: Canvas2DBackendOptions;
    core?: BinaryInput;
    coreUrl?: BinaryInput;
    coreArchive?: BinaryInput;
    compiler?: JavaCompiler;
    compilerOptions?: CreateCompilerOptions;
    sourceMaps?: boolean;
    optimizationLevel?: TeaVMOptimizationLevel;
    optimization?: TeaVMOptimizationLevel;
    fastGlobalAnalysis?: boolean;
    fastDependencyAnalysis?: boolean;
    fallbackToJs?: boolean;
    worker?: boolean | Worker;
    workerUrl?: string | URL;
    wasmName?: string;
    wasmOutputName?: string;
    wasmRuntime?: string | URL;
    wasmRuntimeUrl?: string | URL;
    wasmRuntimeOptions?: Record<string, unknown>;
    sketchWasmRuntime?: string | URL;
    sketchWasmRuntimeUrl?: string | URL;
    sketchWasmRuntimeOptions?: Record<string, unknown>;
    stdio?: JavaProgramConsoleOptions;
    fs?: JavaProgramFileSystemOptions;
    sketchName?: string;
    launcherClass?: string;
    onDiagnostic?: (diagnostic: ProcessingDiagnostic) => void;
    onState?: (state: "compiling" | "emitting" | string) => void;
}
export interface ProcessingCompileOptions extends ProcessingRunOptions {
    diagnosticsElement?: Element;
}
export interface ProcessingDiagnostic {
    type?: string;
    severity?: string;
    fileName?: string | null;
    sourceUrl?: string;
    lineNumber?: number;
    columnNumber?: number;
    generatedFileName?: string | null;
    generatedLineNumber?: number;
    generatedColumnNumber?: number;
    message?: string;
}
export interface ProcessingCompileResult {
    compiler: JavaCompiler;
    compiled: boolean;
    diagnostics: ProcessingDiagnostic[];
    preprocessed: ProcessingPreprocessResult;
    mapper: unknown;
    launcherClass: string;
    launcherSource: string;
}
export interface ProcessingSketchTimings {
    compileMs?: number;
    emitMs?: number;
    totalMs?: number;
    workerStartupMs?: number;
    compileRequestMs?: number;
}
export interface ProcessingGeneratedSketch {
    compiled?: boolean;
    diagnostics?: ProcessingDiagnostic[];
    preprocessed?: ProcessingPreprocessResult;
    launcherClass?: string;
    launcherSource?: string;
    output?: "js" | "wasm-gc";
    moduleText?: string;
    wasmBytes?: Uint8Array;
    wasmFileName?: string;
    sourceMap?: string | null;
    compilerSourceMap?: string | null;
    files?: string[];
    timings?: ProcessingSketchTimings;
}
export interface ProcessingRunResult {
    element: Element;
    output: "js" | "wasm-gc";
    backend: "p5" | "canvas2d";
    p5: unknown | null;
    runtime?: unknown;
    canvas?: HTMLCanvasElement | null;
    sketch: unknown;
    diagnostics: ProcessingDiagnostic[];
    preprocessed: ProcessingPreprocessResult;
    files: string[];
    module?: unknown;
    sourceMap?: string | null;
    compilerSourceMap?: string | null;
    timings?: ProcessingSketchTimings;
    program?: unknown;
    wasmRuntime?: unknown;
    wasmBytes?: Uint8Array;
    wasmFileName?: string;
}
export interface P5Constructor {
    new (sketch: (p: unknown) => void, node?: Element): unknown;
}
export interface Canvas2DBackendOptions {
    canvas?: HTMLCanvasElement;
    document?: Document;
    pixelDensity?: number;
    alpha?: boolean;
    desynchronized?: boolean;
    crossOrigin?: string | false;
}
export declare function runProcessingSketches(options?: ProcessingRunOptions): Promise<ProcessingRunResult[]>;
export declare const runProcessingTags: typeof runProcessingSketches;
export interface ProcessingProgramOptions extends JavaProgramOptions {
    sketchWasmRuntime?: string | URL;
    sketchWasmRuntimeUrl?: string | URL;
    sketchWasmRuntimeOptions?: Record<string, unknown>;
}
export declare function createProcessingProgramOptions(options?: ProcessingProgramOptions): ProcessingProgramOptions;
export declare function createProcessingProgram(wasmBytes: BinaryInput, options?: ProcessingProgramOptions): Promise<ProcessingProgram>;
export declare class ProcessingProgram {
    readonly wasmProgram: any;
    readonly options: ProcessingProgramOptions;
    constructor(wasmProgram: any, options?: ProcessingProgramOptions);
    get exports(): any;
    get instance(): any;
    get module(): any;
    execute(canvasBackendOrOptions: unknown): unknown;
}
export declare function runProcessingElement(element: Element, options?: ProcessingRunOptions, index?: number): Promise<ProcessingRunResult>;
export declare function generateProcessingSketch(sources: Array<string | ProcessingSource>, options?: ProcessingCompileOptions): Promise<ProcessingGeneratedSketch>;
export declare function generateProcessingSketchOnMainThread(sources: Array<string | ProcessingSource>, options?: ProcessingCompileOptions): Promise<ProcessingGeneratedSketch>;
export declare function compileProcessingSketch(sources: Array<string | ProcessingSource>, options?: ProcessingCompileOptions): Promise<ProcessingCompileResult>;
export declare function preprocessProcessing(sources: Array<string | ProcessingSource>, options?: ProcessingCompileOptions): Promise<ProcessingPreprocessResult>;
export declare function emitProcessingSketch(compiled: ProcessingCompileResult, options?: ProcessingCompileOptions): ProcessingGeneratedSketch;
export declare function emitProcessingSketchWithFallback(compiled: ProcessingCompileResult, options?: ProcessingCompileOptions): Promise<ProcessingGeneratedSketch>;
export declare function createCanvas2DBackend(parent: Element, options?: Canvas2DBackendOptions): unknown;
export declare const createCanvas2DHost: typeof createCanvas2DBackend;
export declare function composeTeaVmSourceMap(compilerSourceMapText: string | null | undefined, mapper: unknown, preprocessed: ProcessingPreprocessResult): string | null;
export declare function inlineSourceMap(text: string, sourceMapText?: string | null): string;
export declare class ProcessingLoadError extends Error {
    readonly element: Element | null;
    constructor(element: any, message: any);
}
export declare class ProcessingPreprocessError extends Error {
    readonly preprocessed: ProcessingPreprocessResult;
    readonly issues: ProcessingPreprocessResult["issues"];
    readonly diagnostics: ProcessingDiagnostic[];
    constructor(preprocessed: any, diagnostics?: {
        type: string;
        severity: string;
        fileName: any;
        lineNumber: number;
        columnNumber: number;
        message: any;
        issue: unknown;
    }[]);
}
export declare class ProcessingCompileError extends Error {
    readonly element: Element | null;
    readonly compiled?: ProcessingCompileResult | ProcessingGeneratedSketch;
    readonly diagnostics: ProcessingDiagnostic[];
    readonly preprocessed?: ProcessingPreprocessResult;
    constructor(element: any, message: any, compiled: any);
}
