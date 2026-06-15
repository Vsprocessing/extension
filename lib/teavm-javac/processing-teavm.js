// @ts-nocheck
import { createCompiler, createFileNotFoundError, createJavaProgramOptions, decodedImageByToken, fetchFilePath, getCompilerWasmGCSupport, normalizeStorePath, setActiveProgram, } from "./teavm-javac.js";
const DEFAULT_CORE_URL = new URL("./processing-core-teavm.jar", import.meta.url);
const DEFAULT_PROCESSING_WORKER_URL = new URL("./processing-teavm-worker.js", import.meta.url);
const DEFAULT_SKETCH_WASM_RUNTIME_URL = new URL("./compiler.wasm-runtime.js", import.meta.url);
const DEFAULT_JS_FILE = "processing-sketch.js";
const DEFAULT_WASM_NAME = "processing-sketch";
const BACKEND_P5 = "p5";
const BACKEND_CANVAS2D = "canvas2d";
const OUTPUT_AUTO = "auto";
const OUTPUT_JS = "js";
const OUTPUT_WASM_GC = "wasm-gc";
let coreArchivePromise = null;
let nextWorkerRequestId = 1;
export async function runProcessingSketches(options = {}) {
    const root = options.root ?? document;
    const selector = options.selector ?? "processing";
    const elements = Array.from(root.querySelectorAll(selector));
    const results = [];
    for (let i = 0; i < elements.length; i++) {
        results.push(await runProcessingElement(elements[i], options, i));
    }
    return results;
}
export const runProcessingTags = runProcessingSketches;
export function createProcessingProgramOptions(options = {}) {
    return createJavaProgramOptions(options, openProcessingFilePath);
}
export async function createProcessingProgram(wasmBytes, options = {}) {
    const programOptions = createProcessingProgramOptions(options);
    const runtimeModule = options.runtimeModule ?? await import(String(options.sketchWasmRuntime ??
        options.sketchWasmRuntimeUrl ??
        options.wasmRuntime ??
        options.wasmRuntimeUrl ??
        DEFAULT_SKETCH_WASM_RUNTIME_URL));
    if (typeof runtimeModule.load !== "function") {
        throw new Error("TeaVM Wasm-GC runtime loader did not export load()");
    }
    const wasmProgram = await runtimeModule.load(wasmBytes, programOptions);
    return new ProcessingProgram(wasmProgram, programOptions);
}
export class ProcessingProgram {
    wasmProgram;
    options;
    constructor(wasmProgram, options = {}) {
        this.wasmProgram = wasmProgram;
        this.options = options;
    }
    get exports() {
        return this.wasmProgram?.exports;
    }
    get instance() {
        return this.wasmProgram?.instance;
    }
    get module() {
        return this.wasmProgram?.module;
    }
    execute(canvasBackendOrOptions) {
        const canvasBackend = canvasBackendOrOptions?.canvasBackend ?? canvasBackendOrOptions;
        const start = this.wasmProgram?.exports?.start;
        if (typeof start !== "function") {
            throw new Error("Processing Wasm-GC sketch did not export start(runtime)");
        }
        setActiveProgram(this);
        return start(canvasBackend);
    }
}
export async function runProcessingElement(element, options = {}, index = 0) {
    const src = element.getAttribute("src");
    if (!src) {
        throw new ProcessingLoadError(element, "Processing element is missing src");
    }
    const output = normalizeOutputRequest(element.getAttribute("target") ??
        element.getAttribute("output") ??
        element.getAttribute("type") ??
        options.target ??
        options.output ??
        OUTPUT_AUTO);
    const backend = normalizeSketchBackend(element.getAttribute("backend") ??
        element.getAttribute("renderer") ??
        options.backend ??
        BACKEND_P5);
    const sources = await loadPdeSources(src, element, options);
    const sketchName = toJavaIdentifier(options.sketchName ??
        element.getAttribute("sketch-name") ??
        firstSourceBaseName(sources[0]?.path ?? `Sketch${index + 1}`));
    setState(element, "compiling");
    const generated = await generateProcessingSketch(sources, {
        ...options,
        backend,
        output,
        sketchName,
        diagnosticsElement: element,
        onState: (state) => {
            setState(element, state);
            options.onState?.(state);
        },
    });
    if (!generated.compiled) {
        setState(element, "error");
        throw new ProcessingCompileError(element, "Java compilation failed", generated);
    }
    setState(element, "emitting");
    let result;
    try {
        result = await mountGeneratedSketch(generated, element, {
            ...options,
            backend,
            output,
        });
    }
    catch (error) {
        if (!shouldFallbackToJavaScript(output, generated, options)) {
            throw error;
        }
        setState(element, "emitting");
        const fallbackGenerated = await generateProcessingSketch(sources, {
            ...options,
            backend,
            output: OUTPUT_JS,
            target: OUTPUT_JS,
            sketchName,
            diagnosticsElement: element,
            fallbackToJs: false,
            onState: (state) => {
                setState(element, state);
                options.onState?.(state);
            },
        });
        fallbackGenerated.diagnostics = [
            ...(fallbackGenerated.diagnostics ?? []),
            createProcessingWasmFallbackDiagnostic(`the generated Wasm-GC sketch failed to load: ${error?.message ?? error}`),
        ];
        result = await mountGeneratedSketch(fallbackGenerated, element, {
            ...options,
            backend,
            output: OUTPUT_JS,
        });
    }
    setState(element, "running");
    return result;
}
export async function generateProcessingSketch(sources, options = {}) {
    if (shouldUseProcessingWorker(options)) {
        return await generateProcessingSketchInWorker(sources, options);
    }
    return await generateProcessingSketchOnMainThread(sources, options);
}
export async function generateProcessingSketchOnMainThread(sources, options = {}) {
    const compiled = await compileProcessingSketch(sources, options);
    const serialized = serializeCompiledSketch(compiled);
    if (!compiled.compiled) {
        return serialized;
    }
    const generated = await emitProcessingSketchWithFallback(compiled, options);
    return {
        ...generated,
        diagnostics: [
            ...serialized.diagnostics,
            ...(generated.diagnostics ?? []),
        ],
        preprocessed: serialized.preprocessed,
        launcherClass: serialized.launcherClass,
        launcherSource: serialized.launcherSource,
    };
}
export async function compileProcessingSketch(sources, options = {}) {
    const normalizedSources = normalizeSources(sources);
    const backend = normalizeSketchBackend(options.backend ?? options.renderer ?? BACKEND_P5);
    const compiler = options.compiler ?? await createCompiler(options.compilerOptions ?? {});
    const diagnostics = [];
    const preprocessed = compiler.preprocessProcessing(normalizedSources, {
        sketchName: options.sketchName ?? firstSourceBaseName(normalizedSources[0]?.path),
    });
    const mapper = createProcessingMapper(preprocessed, normalizedSources);
    if (!preprocessed.ok) {
        const preprocessDiagnostics = createPreprocessDiagnostics(preprocessed);
        diagnostics.push(...preprocessDiagnostics);
        for (const diagnostic of preprocessDiagnostics) {
            options.onDiagnostic?.(diagnostic);
            dispatchProcessingDiagnostic(options.diagnosticsElement, diagnostic);
        }
        throw new ProcessingPreprocessError(preprocessed, preprocessDiagnostics);
    }
    compiler.onDiagnostic((diagnostic) => {
        const mapped = mapDiagnostic(toPlainDiagnostic(diagnostic), mapper);
        diagnostics.push(mapped);
        options.onDiagnostic?.(mapped);
        dispatchProcessingDiagnostic(options.diagnosticsElement, mapped);
    });
    const launcherClass = toJavaIdentifier(options.launcherClass ?? `${preprocessed.className}Launcher`);
    const launcherSource = createLauncherSource(launcherClass, preprocessed.className, backend);
    const coreArchive = await getCoreArchive(options);
    compiler.addDependencyArchive(coreArchive);
    compiler.addClassArchive(coreArchive);
    compiler.addSource(preprocessed.sourceFileName, preprocessed.javaSource);
    compiler.addSource(`${launcherClass}.java`, launcherSource);
    return {
        compiler,
        compiled: compiler.compile(),
        diagnostics,
        preprocessed,
        mapper,
        launcherClass,
        launcherSource,
    };
}
export async function preprocessProcessing(sources, options = {}) {
    const compiler = options.compiler ?? await createCompiler(options.compilerOptions ?? {});
    return compiler.preprocessProcessing(normalizeSources(sources), options);
}
export function emitProcessingSketch(compiled, options = {}) {
    const output = normalizeConcreteOutput(options.output ?? options.target ?? OUTPUT_WASM_GC);
    if (output === OUTPUT_WASM_GC) {
        return emitProcessingWebAssembly(compiled, options);
    }
    return emitProcessingJavaScript(compiled, options);
}
export async function emitProcessingSketchWithFallback(compiled, options = {}) {
    const requestedOutput = normalizeOutputRequest(options.output ?? options.target ?? OUTPUT_AUTO);
    const resolved = await resolveProcessingOutput(requestedOutput, options);
    const emitOptions = {
        ...options,
        output: resolved.output,
        target: resolved.output,
        fastGlobalAnalysis: resolveFastGlobalAnalysis(options, resolved.output, resolved.automatic),
    };
    const fallbackDiagnostics = resolved.diagnostic ? [resolved.diagnostic] : [];
    try {
        const emitted = emitProcessingSketch(compiled, emitOptions);
        return fallbackDiagnostics.length > 0
            ? { ...emitted, diagnostics: fallbackDiagnostics }
            : emitted;
    }
    catch (error) {
        if (!resolved.automatic || resolved.output !== OUTPUT_WASM_GC || options.fallbackToJs === false) {
            throw error;
        }
        const diagnostic = createProcessingWasmFallbackDiagnostic(`TeaVM Wasm-GC emit failed: ${error?.message ?? error}`);
        const emitted = emitProcessingJavaScript(compiled, {
            ...emitOptions,
            output: OUTPUT_JS,
            target: OUTPUT_JS,
        });
        return {
            ...emitted,
            diagnostics: [
                ...fallbackDiagnostics,
                diagnostic,
            ],
        };
    }
}
function emitProcessingJavaScript(compiled, options) {
    const sourceMapName = `${DEFAULT_JS_FILE}.map`;
    const emitted = compiled.compiler.emitJs({
        mainClass: compiled.launcherClass,
        module: "esm",
        fileName: DEFAULT_JS_FILE,
        sourceMap: options.sourceMaps !== false,
        sourceMapName,
        optimizationLevel: options.optimizationLevel ?? options.optimization ?? "simple",
        fastGlobalAnalysis: resolveFastGlobalAnalysis(options, OUTPUT_JS, false),
    });
    if (!emitted.ok || !emitted.text) {
        throw new ProcessingCompileError(null, "TeaVM JavaScript emit failed", compiled);
    }
    const sourceMap = composeTeaVmSourceMap(emitted.sourceMapText, compiled.mapper, compiled.preprocessed);
    const moduleText = inlineSourceMap(emitted.text, sourceMap);
    return {
        output: "js",
        moduleText,
        sourceMap,
        compilerSourceMap: emitted.sourceMapText,
        files: emitted.files,
    };
}
function emitProcessingWebAssembly(compiled, options) {
    const outputName = normalizeWasmOutputName(options.wasmName ??
        options.wasmOutputName ??
        options.outputName ??
        options.name ??
        DEFAULT_WASM_NAME);
    let emitted;
    try {
        emitted = compiled.compiler.emitWasm({
            mainClass: compiled.launcherClass,
            outputName,
            optimizationLevel: options.optimizationLevel ?? options.optimization ?? "simple",
            fastGlobalAnalysis: resolveFastGlobalAnalysis(options, OUTPUT_WASM_GC, false),
        });
    }
    catch (cause) {
        throw createProcessingEmitError(null, `TeaVM Wasm-GC emit failed: ${cause?.message ?? cause}`, compiled, cause);
    }
    if (!emitted.ok || !emitted.bytes) {
        throw createProcessingEmitError(null, "TeaVM Wasm-GC emit failed", compiled);
    }
    return {
        output: OUTPUT_WASM_GC,
        wasmBytes: emitted.bytes,
        wasmFileName: emitted.fileName,
        files: emitted.files,
    };
}
async function mountGeneratedSketch(generated, element, options) {
    if (generated.output === OUTPUT_WASM_GC) {
        return await mountGeneratedWasmSketch(generated, element, options);
    }
    if (!generated.moduleText) {
        throw new ProcessingCompileError(element, "TeaVM JavaScript emit failed", generated);
    }
    const moduleUrl = URL.createObjectURL(new Blob([generated.moduleText], { type: "text/javascript" }));
    try {
        const module = await import(moduleUrl);
        const mounted = await mountSketch(element, module.start, options);
        return {
            element,
            output: "js",
            module,
            backend: mounted.backend,
            p5: mounted.p5,
            runtime: mounted.runtime,
            canvas: mounted.canvas,
            sketch: mounted.sketch,
            diagnostics: generated.diagnostics,
            preprocessed: generated.preprocessed,
            sourceMap: generated.sourceMap,
            compilerSourceMap: generated.compilerSourceMap,
            files: generated.files,
            timings: generated.timings,
        };
    }
    finally {
        URL.revokeObjectURL(moduleUrl);
    }
}
async function mountGeneratedWasmSketch(generated, element, options) {
    if (!generated.wasmBytes) {
        throw new ProcessingCompileError(element, "TeaVM Wasm-GC emit failed", generated);
    }
    const program = await createProcessingProgram(generated.wasmBytes, {
        ...options,
        wasmRuntimeOptions: options.sketchWasmRuntimeOptions ?? options.wasmRuntimeOptions ?? options.runtimeOptions ?? {},
    });
    const mounted = await mountSketch(element, (canvasBackend) => program.execute({ canvasBackend }), options);
    return {
        element,
        output: OUTPUT_WASM_GC,
        program,
        wasmRuntime: program.wasmProgram,
        wasmBytes: generated.wasmBytes,
        wasmFileName: generated.wasmFileName,
        backend: mounted.backend,
        p5: mounted.p5,
        runtime: mounted.runtime,
        canvas: mounted.canvas,
        sketch: mounted.sketch,
        diagnostics: generated.diagnostics,
        preprocessed: generated.preprocessed,
        files: generated.files,
        timings: generated.timings,
    };
}
async function generateProcessingSketchInWorker(sources, options) {
    const { worker, owned } = createProcessingWorker(options);
    const id = nextWorkerRequestId++;
    const transfer = [];
    const payload = {
        sources: normalizeSources(sources),
        options: await createWorkerOptions(options, transfer),
    };
    options.onState?.("compiling");
    try {
        return await new Promise((resolve, reject) => {
            const cleanup = () => {
                worker.removeEventListener("message", handleMessage);
                worker.removeEventListener("error", handleError);
                if (owned) {
                    worker.terminate();
                }
            };
            const handleError = (event) => {
                cleanup();
                reject(new Error(event.message || "Processing worker failed"));
            };
            const handleMessage = (event) => {
                const message = event.data;
                if (!message || message.id !== id) {
                    return;
                }
                if (message.type === "state") {
                    options.onState?.(message.state);
                    return;
                }
                if (message.type === "diagnostic") {
                    options.onDiagnostic?.(message.diagnostic);
                    dispatchProcessingDiagnostic(options.diagnosticsElement, message.diagnostic);
                    return;
                }
                cleanup();
                if (message.type === "result") {
                    resolve(message.result);
                }
                else if (message.type === "error") {
                    reject(createWorkerError(message.error));
                }
                else {
                    reject(new Error(`Unexpected Processing worker message: ${message.type}`));
                }
            };
            worker.addEventListener("message", handleMessage);
            worker.addEventListener("error", handleError);
            worker.postMessage({ id, command: "compile-processing", payload }, transfer);
        });
    }
    catch (error) {
        if (owned) {
            worker.terminate();
        }
        throw error;
    }
}
function shouldUseProcessingWorker(options) {
    return options.worker !== false
        && options.compiler == null
        && typeof Worker === "function";
}
function createProcessingWorker(options) {
    if (options.worker && typeof options.worker.postMessage === "function") {
        return { worker: options.worker, owned: false };
    }
    const workerUrl = options.workerUrl ?? DEFAULT_PROCESSING_WORKER_URL;
    return {
        worker: new Worker(workerUrl, {
            type: "module",
            name: "processing-teavm-codegen",
        }),
        owned: true,
    };
}
async function createWorkerOptions(options, transfer) {
    return {
        compilerOptions: serializeCompilerOptionsForWorker(options.compilerOptions, transfer),
        core: await serializeBinaryOrUrlForWorker(options.coreArchive ?? options.core ?? options.coreUrl ?? DEFAULT_CORE_URL, transfer),
        sourceMaps: options.sourceMaps,
        optimizationLevel: options.optimizationLevel ?? options.optimization ?? "simple",
        fastGlobalAnalysis: resolveFastGlobalAnalysis(options, normalizeOutputRequest(options.output ?? options.target ?? OUTPUT_AUTO), isAutomaticOutput(options.output ?? options.target ?? OUTPUT_AUTO)),
        output: normalizeOutputRequest(options.output ?? options.target ?? OUTPUT_AUTO),
        backend: normalizeSketchBackend(options.backend ?? options.renderer ?? BACKEND_P5),
        sketchName: options.sketchName,
        launcherClass: options.launcherClass,
        wasmName: options.wasmName ?? options.wasmOutputName ?? options.outputName ?? options.name,
    };
}
function serializeCompilerOptionsForWorker(options = {}, transfer) {
    const result = {};
    for (const [key, value] of Object.entries(options ?? {})) {
        if (typeof value === "function") {
            continue;
        }
        if (value instanceof URL) {
            result[key] = String(value);
        }
        else if (isBinaryInput(value)) {
            result[key] = copyBinaryForWorker(value, transfer);
        }
        else if (value == null || typeof value !== "object" || Array.isArray(value)) {
            result[key] = value;
        }
        else if (key === "wasmRuntimeOptions" || key === "runtimeOptions") {
            result[key] = value;
        }
    }
    return result;
}
async function serializeBinaryOrUrlForWorker(value, transfer) {
    if (typeof value === "string" || value instanceof URL) {
        return String(value);
    }
    return copyBinaryForWorker(value, transfer);
}
function copyBinaryForWorker(value, transfer) {
    const bytes = toBytes(value);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    transfer.push(copy.buffer);
    return copy;
}
function serializeCompiledSketch(compiled) {
    return {
        compiled: compiled.compiled,
        diagnostics: compiled.diagnostics,
        preprocessed: compiled.preprocessed,
        launcherClass: compiled.launcherClass,
        launcherSource: compiled.launcherSource,
    };
}
function createWorkerError(details = {}) {
    const error = new Error(details.message ?? "Processing worker failed");
    error.name = details.name ?? "ProcessingWorkerError";
    if (details.stack) {
        error.stack = details.stack;
    }
    error.diagnostics = details.diagnostics ?? [];
    error.issues = details.issues ?? [];
    error.preprocessed = details.preprocessed;
    return error;
}
function createProcessingEmitError(element, message, compiled, cause) {
    const error = new ProcessingCompileError(element, message, compiled);
    if (error.diagnostics.length === 0) {
        error.diagnostics = [{
                type: "teavm",
                severity: "error",
                fileName: null,
                message,
            }];
    }
    if (cause !== undefined) {
        error.cause = cause;
        if (cause?.stack) {
            error.stack = cause.stack;
        }
    }
    return error;
}
function createProcessingWasmFallbackDiagnostic(reason) {
    return {
        type: "processing-wasm-gc",
        severity: "warning",
        fileName: null,
        message: `Processing Wasm-GC output is not available (${reason}); falling back to JavaScript output. Use a supporting browser such as modern Chrome for Wasm-GC sketches.`,
    };
}
async function resolveProcessingOutput(requestedOutput, options = {}) {
    if (requestedOutput !== OUTPUT_AUTO) {
        return {
            output: requestedOutput,
            automatic: false,
            diagnostic: null,
        };
    }
    const support = await getCompilerWasmGCSupport();
    if (support.supported) {
        return {
            output: OUTPUT_WASM_GC,
            automatic: true,
            diagnostic: null,
        };
    }
    return {
        output: OUTPUT_JS,
        automatic: true,
        diagnostic: options.fallbackToJs === false
            ? null
            : createProcessingWasmFallbackDiagnostic(support.reason ?? "Wasm-GC, JSPI, or js-string builtins are not available"),
    };
}
function resolveFastGlobalAnalysis(options, output, automatic) {
    if (options.fastGlobalAnalysis != null || options.fastDependencyAnalysis != null) {
        return Boolean(options.fastGlobalAnalysis ?? options.fastDependencyAnalysis);
    }
    return automatic || output === OUTPUT_WASM_GC;
}
function shouldFallbackToJavaScript(requestedOutput, generated, options) {
    return options.fallbackToJs !== false
        && requestedOutput === OUTPUT_AUTO
        && generated?.output === OUTPUT_WASM_GC;
}
function dispatchProcessingDiagnostic(element, diagnostic) {
    if (!element || typeof element.dispatchEvent !== "function" || typeof CustomEvent !== "function") {
        return;
    }
    element.dispatchEvent(new CustomEvent("processingdiagnostic", {
        detail: diagnostic,
    }));
}
async function mountSketch(element, start, options = {}) {
    const backend = normalizeSketchBackend(options.backend ?? options.renderer ?? BACKEND_P5);
    if (backend === BACKEND_CANVAS2D) {
        return mountCanvas2DSketch(element, start, options);
    }
    return mountP5Sketch(element, start, options);
}
async function mountP5Sketch(element, start, options) {
    const P5 = options.p5 ?? globalThis.p5;
    if (typeof P5 !== "function") {
        throw new ProcessingLoadError(element, "p5.js is not loaded; pass { p5 } or load p5 before running sketches");
    }
    element.replaceChildren();
    element.style.display ||= "block";
    return await new Promise((resolve, reject) => {
        let p5Instance = null;
        p5Instance = new P5((p) => {
            p.setup = () => {
                try {
                    const sketch = start(p);
                    element.dispatchEvent(new CustomEvent("processingready", {
                        detail: { backend: BACKEND_P5, p5: p5Instance, sketch },
                    }));
                    resolve({
                        backend: BACKEND_P5,
                        p5: p5Instance,
                        runtime: p5Instance,
                        canvas: p?.canvas ?? p?._renderer?.canvas,
                        sketch,
                    });
                }
                catch (error) {
                    reject(error);
                }
            };
        }, element);
    });
}
async function mountCanvas2DSketch(element, start, options) {
    element.replaceChildren();
    element.style.display ||= "block";
    const canvasBackend = createCanvas2DBackend(element, options.canvas2d ?? options.canvasOptions ?? {});
    const sketch = start(canvasBackend);
    element.dispatchEvent(new CustomEvent("processingready", {
        detail: {
            backend: BACKEND_CANVAS2D,
            canvas: canvasBackend.canvas,
            sketch,
        },
    }));
    return {
        backend: BACKEND_CANVAS2D,
        p5: null,
        runtime: canvasBackend,
        canvas: canvasBackend.canvas,
        sketch,
    };
}
export function createCanvas2DBackend(parent, options = {}) {
    const ownerDocument = options.document ?? parent?.ownerDocument ?? globalThis.document;
    if (!ownerDocument) {
        throw new ProcessingLoadError(null, "Canvas2D backend requires a browser document");
    }
    const state = {
        canvas: null,
        context: null,
        renderer: null,
        width: 0,
        height: 0,
        density: normalizePixelDensity(options.pixelDensity),
        fillEnabled: true,
        strokeEnabled: true,
        fillStyle: "rgba(255,255,255,1)",
        strokeStyle: "rgba(0,0,0,1)",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        tintEnabled: false,
        tintStyle: "rgba(255,255,255,1)",
        textSize: 12,
        fontFamily: "sans-serif",
        textAlign: "left",
        textBaseline: "alphabetic",
        blendMode: "source-over",
        clipActive: false,
        shape: null,
        imageData: null,
    };
    const backend = {
        canvas: null,
        elt: null,
        _renderer: null,
        width: 0,
        height: 0,
        pixels: null,
        ROUND: "round",
        PROJECT: "square",
        SQUARE: "butt",
        MITER: "miter",
        BEVEL: "bevel",
        CLOSE: "close",
        OPEN: "open",
        CHORD: "chord",
        PIE: "pie",
        LINES: "lines",
        TRIANGLES: "triangles",
        TRIANGLE_STRIP: "triangle_strip",
        TRIANGLE_FAN: "triangle_fan",
        QUADS: "quads",
        QUAD_STRIP: "quad_strip",
        POINTS: "points",
        LINE_STRIP: "line_strip",
        LINE_LOOP: "line_loop",
        LEFT: "left",
        CENTER: "center",
        RIGHT: "right",
        TOP: "top",
        BOTTOM: "bottom",
        BASELINE: "alphabetic",
        noLoop() {
        },
        pixelDensity(value) {
            if (value != null) {
                state.density = normalizePixelDensity(value);
                if (state.canvas) {
                    resizeCanvas(state.width, state.height);
                }
            }
            return state.density;
        },
        createCanvas(width, height) {
            ensureCanvas();
            resizeCanvas(width, height);
            return state.renderer;
        },
        resizeCanvas(width, height) {
            ensureCanvas();
            resizeCanvas(width, height);
        },
        loadPixels() {
            const context = context2d();
            state.imageData = context.getImageData(0, 0, state.canvas.width, state.canvas.height);
            backend.pixels = state.imageData.data;
        },
        updatePixels() {
            if (!state.imageData) {
                return;
            }
            context2d().putImageData(state.imageData, 0, 0);
        },
        background(r, g, b, a) {
            const context = context2d();
            context.save();
            setBaseTransform(context);
            context.clearRect(0, 0, state.width, state.height);
            context.fillStyle = rgba(r, g, b, a);
            context.fillRect(0, 0, state.width, state.height);
            context.restore();
        },
        fill(r, g, b, a) {
            state.fillEnabled = true;
            state.fillStyle = rgba(r, g, b, a);
            applyStyles();
        },
        noFill() {
            state.fillEnabled = false;
        },
        stroke(r, g, b, a) {
            state.strokeEnabled = true;
            state.strokeStyle = rgba(r, g, b, a);
            applyStyles();
        },
        noStroke() {
            state.strokeEnabled = false;
        },
        strokeWeight(weight) {
            state.lineWidth = Math.max(0, Number(weight) || 0);
            applyStyles();
        },
        strokeCap(cap) {
            state.lineCap = normalizeLineCap(cap);
            applyStyles();
        },
        strokeJoin(join) {
            state.lineJoin = normalizeLineJoin(join);
            applyStyles();
        },
        tint(r, g, b, a) {
            state.tintEnabled = true;
            state.tintStyle = rgba(r, g, b, a);
        },
        noTint() {
            state.tintEnabled = false;
        },
        push() {
            context2d().save();
        },
        pop() {
            context2d().restore();
            applyStyles();
        },
        clipRect(x, y, width, height) {
            if (state.clipActive) {
                backend.noClip();
            }
            const context = context2d();
            context.save();
            context.beginPath();
            context.rect(x, y, width, height);
            context.clip();
            state.clipActive = true;
            applyStyles();
        },
        noClip() {
            if (!state.clipActive) {
                return;
            }
            context2d().restore();
            state.clipActive = false;
            applyStyles();
        },
        blendMode(mode) {
            state.blendMode = normalizeBlendMode(mode);
            applyStyles();
        },
        resetMatrix() {
            setBaseTransform(context2d());
        },
        translate(x, y) {
            context2d().translate(x, y);
        },
        rotate(angle) {
            context2d().rotate(angle);
        },
        scale(x, y) {
            context2d().scale(x, y);
        },
        applyMatrix(a, b, c, d, e, f) {
            context2d().transform(a, b, c, d, e, f);
        },
        point(x, y) {
            if (!state.strokeEnabled || state.lineWidth <= 0) {
                return;
            }
            const context = context2d();
            context.save();
            context.fillStyle = state.strokeStyle;
            if (state.lineCap === "butt") {
                context.restore();
                return;
            }
            if (state.lineCap === "round") {
                context.beginPath();
                context.arc(x, y, state.lineWidth / 2, 0, Math.PI * 2);
                context.fill();
            }
            else {
                const size = Math.max(state.lineWidth, 1 / state.density);
                context.fillRect(x - size / 2, y - size / 2, size, size);
            }
            context.restore();
        },
        line(x1, y1, x2, y2) {
            if (!state.strokeEnabled || state.lineWidth <= 0) {
                return;
            }
            const context = context2d();
            context.beginPath();
            context.moveTo(x1, y1);
            context.lineTo(x2, y2);
            context.stroke();
        },
        triangle(x1, y1, x2, y2, x3, y3) {
            drawPolygon([[x1, y1], [x2, y2], [x3, y3]], true);
        },
        quad(x1, y1, x2, y2, x3, y3, x4, y4) {
            drawPolygon([[x1, y1], [x2, y2], [x3, y3], [x4, y4]], true);
        },
        rect(x, y, width, height) {
            const context = context2d();
            context.beginPath();
            context.rect(x, y, width, height);
            paintPath();
        },
        roundedRect(x, y, width, height, tl, tr, br, bl) {
            const context = context2d();
            context.beginPath();
            if (typeof context.roundRect === "function") {
                context.roundRect(x, y, width, height, [tl, tr, br, bl].map((value) => Math.max(0, value || 0)));
            }
            else {
                roundedRectPath(context, x, y, width, height, tl, tr, br, bl);
            }
            paintPath();
        },
        ellipse(x, y, width, height) {
            const context = context2d();
            context.beginPath();
            context.ellipse(x, y, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
            paintPath();
        },
        arc(x, y, width, height, start, stop, mode) {
            const context = context2d();
            const radiusX = Math.abs(width / 2);
            const radiusY = Math.abs(height / 2);
            const normalizedMode = mode ?? "default";
            if (state.fillEnabled) {
                drawArcPath(context, x, y, radiusX, radiusY, start, stop, fillArcMode(normalizedMode));
                context.fill();
            }
            if (state.strokeEnabled && state.lineWidth > 0) {
                drawArcPath(context, x, y, radiusX, radiusY, start, stop, strokeArcMode(normalizedMode));
                context.stroke();
            }
        },
        beginShape(kind) {
            state.shape = {
                kind,
                vertices: [],
                hasPath: false,
                pathStarted: false,
                breakShape: false,
                openContour: false,
            };
        },
        vertex(x, y) {
            if (state.shape) {
                state.shape.vertices.push([x, y]);
                if (isPathShape(state.shape.kind)) {
                    addPathVertex(x, y);
                }
            }
        },
        beginContour() {
            if (!state.shape || !isPathShape(state.shape.kind) || state.shape.openContour) {
                return;
            }
            state.shape.breakShape = true;
            state.shape.openContour = true;
        },
        endContour() {
            if (!state.shape || !state.shape.openContour) {
                return;
            }
            if (state.shape.hasPath) {
                context2d().closePath();
            }
            state.shape.openContour = false;
            state.shape.breakShape = true;
        },
        bezierVertex(x1, y1, x2, y2, x3, y3) {
            if (!state.shape || !isPathShape(state.shape.kind) || !state.shape.pathStarted) {
                return;
            }
            const context = context2d();
            context.bezierCurveTo(x1, y1, x2, y2, x3, y3);
            state.shape.vertices.push([x3, y3]);
        },
        curveVertexSegment(x0, y0, x1, y1, x2, y2, x3, y3) {
            if (!state.shape || !isPathShape(state.shape.kind)) {
                return;
            }
            if (!state.shape.pathStarted) {
                addPathVertex(x0, y0);
            }
            const context = context2d();
            context.bezierCurveTo(x1, y1, x2, y2, x3, y3);
            state.shape.vertices.push([x3, y3]);
        },
        endShape(close) {
            const shape = state.shape;
            state.shape = null;
            if (!shape) {
                return;
            }
            if (isPathShape(shape.kind)) {
                if (shape.openContour && shape.hasPath) {
                    context2d().closePath();
                }
                if (close && shape.hasPath) {
                    context2d().closePath();
                }
                if (shape.hasPath) {
                    paintPath();
                }
                return;
            }
            drawShape(shape.kind, shape.vertices, close);
        },
        image(image, x, y, width, height, sx, sy, sw, sh) {
            const source = nativeImageSource(image);
            if (!source || source.width === 0 || source.height === 0) {
                return;
            }
            const context = context2d();
            if (state.tintEnabled) {
                context.save();
                context.globalAlpha = extractAlpha(state.tintStyle);
            }
            try {
                context.drawImage(source, sx, sy, sw, sh, x, y, width, height);
            }
            catch {
                // Browser image loading is async; skip frames until the image is ready.
            }
            finally {
                if (state.tintEnabled) {
                    context.restore();
                }
            }
        },
        text(text, x, y) {
            const context = context2d();
            if (state.fillEnabled) {
                context.fillText(String(text ?? ""), java2DTextCoordinate(x), java2DTextCoordinate(y));
            }
        },
        textSize(size) {
            state.textSize = Math.max(1, Number(size) || 1);
            applyStyles();
        },
        textFont(font) {
            state.fontFamily = cssFontFamily(font);
            applyStyles();
        },
        textAlign(alignX, alignY) {
            state.textAlign = "left";
            state.textBaseline = "alphabetic";
            applyStyles();
        },
        textWidth(text) {
            return context2d().measureText(String(text ?? "")).width;
        },
        textAscent() {
            const metrics = context2d().measureText("Hg");
            return finitePositive(metrics.fontBoundingBoxAscent)
                ?? finitePositive(metrics.actualBoundingBoxAscent)
                ?? state.textSize * 0.8;
        },
        textDescent() {
            const metrics = context2d().measureText("Hg");
            return finitePositive(metrics.fontBoundingBoxDescent)
                ?? finitePositive(metrics.actualBoundingBoxDescent)
                ?? state.textSize * 0.2;
        },
        cursor(cursor) {
            ensureCanvas();
            state.canvas.style.cursor = cursor || "default";
        },
        noCursor() {
            ensureCanvas();
            state.canvas.style.cursor = "none";
        },
        loadImage(path) {
            const decoded = decodedImageByToken(path);
            if (decoded) {
                return decoded;
            }
            const image = new ownerDocument.defaultView.Image();
            if (options.crossOrigin !== false) {
                image.crossOrigin = options.crossOrigin ?? "anonymous";
            }
            image.src = path;
            return image;
        },
        createImage(width, height) {
            return createNativeImage(ownerDocument, width, height);
        },
        save(target, name) {
            const source = nativeImageSource(target) ?? state.canvas;
            if (!source || typeof source.toDataURL !== "function") {
                return false;
            }
            const anchor = ownerDocument.createElement("a");
            anchor.download = name || "sketch.png";
            anchor.href = source.toDataURL("image/png");
            anchor.click();
            return true;
        },
    };
    return backend;
    function ensureCanvas() {
        if (state.canvas) {
            return;
        }
        const suppliedCanvas = options.canvas ?? null;
        const canvas = suppliedCanvas ?? ownerDocument.createElement("canvas");
        state.canvas = canvas;
        state.context = canvas.getContext("2d", canvasContextOptions(options));
        if (!state.context) {
            throw new ProcessingLoadError(parent ?? null, "Canvas2D backend could not create a 2D canvas context");
        }
        state.renderer = {
            canvas,
            elt: canvas,
        };
        backend.canvas = canvas;
        backend.elt = canvas;
        backend._renderer = state.renderer;
        if (!suppliedCanvas && parent && typeof parent.appendChild === "function") {
            parent.appendChild(canvas);
        }
        canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
        canvas.style.outline = canvas.style.outline || "none";
        applyStyles();
    }
    function context2d() {
        ensureCanvas();
        return state.context;
    }
    function resizeCanvas(width, height) {
        state.width = Math.max(1, Math.round(Number(width) || 1));
        state.height = Math.max(1, Math.round(Number(height) || 1));
        backend.width = state.width;
        backend.height = state.height;
        state.canvas.width = Math.max(1, Math.round(state.width * state.density));
        state.canvas.height = Math.max(1, Math.round(state.height * state.density));
        state.canvas.style.width = `${state.width}px`;
        state.canvas.style.height = `${state.height}px`;
        state.imageData = null;
        backend.pixels = null;
        setBaseTransform(state.context);
        applyStyles();
    }
    function applyStyles() {
        if (!state.context) {
            return;
        }
        state.context.fillStyle = state.fillStyle;
        state.context.strokeStyle = state.strokeStyle;
        state.context.lineWidth = state.lineWidth;
        state.context.lineCap = state.lineCap;
        state.context.lineJoin = state.lineJoin;
        state.context.font = `${state.textSize}px ${state.fontFamily}`;
        state.context.textAlign = state.textAlign;
        state.context.textBaseline = state.textBaseline;
        state.context.globalCompositeOperation = state.blendMode;
    }
    function setBaseTransform(context) {
        context.setTransform(state.density, 0, 0, state.density, 0, 0);
    }
    function paintPath() {
        const context = context2d();
        if (state.fillEnabled) {
            context.fill();
        }
        if (state.strokeEnabled && state.lineWidth > 0) {
            context.stroke();
        }
    }
    function drawPolygon(vertices, close) {
        if (vertices.length === 0) {
            return;
        }
        const context = context2d();
        context.beginPath();
        context.moveTo(vertices[0][0], vertices[0][1]);
        for (let i = 1; i < vertices.length; i++) {
            context.lineTo(vertices[i][0], vertices[i][1]);
        }
        if (close) {
            context.closePath();
        }
        paintPath();
    }
    function isPathShape(kind) {
        return kind == null || kind === "polygon";
    }
    function addPathVertex(x, y) {
        const shape = state.shape;
        if (!shape) {
            return;
        }
        const context = context2d();
        if (!shape.hasPath) {
            context.beginPath();
            shape.hasPath = true;
            shape.pathStarted = false;
        }
        if (!shape.pathStarted || shape.breakShape) {
            context.moveTo(x, y);
            shape.pathStarted = true;
            shape.breakShape = false;
        }
        else {
            context.lineTo(x, y);
        }
    }
    function drawArcPath(context, x, y, radiusX, radiusY, start, stop, mode) {
        context.beginPath();
        if (mode === "pie") {
            context.moveTo(x, y);
        }
        context.ellipse(x, y, radiusX, radiusY, 0, start, stop);
        if (mode === "pie" || mode === "chord") {
            context.closePath();
        }
    }
    function fillArcMode(mode) {
        return mode === "open" ? "open" : mode === "chord" ? "chord" : "pie";
    }
    function strokeArcMode(mode) {
        return mode === "pie" ? "pie" : mode === "chord" ? "chord" : "open";
    }
    function drawShape(kind, vertices, close) {
        switch (kind) {
            case "points":
                for (const vertex of vertices) {
                    backend.point(vertex[0], vertex[1]);
                }
                break;
            case "lines":
                for (let i = 0; i + 1 < vertices.length; i += 2) {
                    backend.line(vertices[i][0], vertices[i][1], vertices[i + 1][0], vertices[i + 1][1]);
                }
                break;
            case "line_strip":
                for (let i = 1; i < vertices.length; i++) {
                    backend.line(vertices[i - 1][0], vertices[i - 1][1], vertices[i][0], vertices[i][1]);
                }
                break;
            case "line_loop":
                for (let i = 1; i < vertices.length; i++) {
                    backend.line(vertices[i - 1][0], vertices[i - 1][1], vertices[i][0], vertices[i][1]);
                }
                if (vertices.length > 2) {
                    backend.line(vertices[vertices.length - 1][0], vertices[vertices.length - 1][1], vertices[0][0], vertices[0][1]);
                }
                break;
            case "triangles":
                for (let i = 0; i + 2 < vertices.length; i += 3) {
                    drawPolygon([vertices[i], vertices[i + 1], vertices[i + 2]], true);
                }
                break;
            case "triangle_strip":
                for (let i = 2; i < vertices.length; i++) {
                    drawPolygon([vertices[i - 2], vertices[i - 1], vertices[i]], true);
                }
                break;
            case "triangle_fan":
                for (let i = 2; i < vertices.length; i++) {
                    drawPolygon([vertices[0], vertices[i - 1], vertices[i]], true);
                }
                break;
            case "quads":
                for (let i = 0; i + 3 < vertices.length; i += 4) {
                    drawPolygon([vertices[i], vertices[i + 1], vertices[i + 2], vertices[i + 3]], true);
                }
                break;
            case "quad_strip":
                for (let i = 0; i + 3 < vertices.length; i += 2) {
                    drawPolygon([vertices[i], vertices[i + 1], vertices[i + 3], vertices[i + 2]], true);
                }
                break;
            default:
                drawPolygon(vertices, close);
                break;
        }
    }
}
export const createCanvas2DHost = createCanvas2DBackend;
async function openProcessingFilePath(path, mode = "read") {
    mode = String(mode || "read");
    if (mode === "write" || mode === "append") {
        return new Uint8Array(0);
    }
    const candidates = processingOpenReadPaths(path);
    for (const candidate of candidates) {
        try {
            return await fetchFilePath(candidate);
        }
        catch (error) {
            if (error?.name !== "FileNotFoundError") {
                throw error;
            }
        }
    }
    throw createFileNotFoundError(path);
}
function processingOpenReadPaths(path) {
    const normalized = normalizeStorePath(path);
    if (!normalized || normalized.startsWith("data/") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
        return [normalized];
    }
    return [`data/${normalized}`, normalized];
}
async function loadPdeSources(src, element, options) {
    const paths = parseSourceList(src);
    const baseUrl = options.baseUrl ?? element.ownerDocument.baseURI;
    return await Promise.all(paths.map(async (path) => {
        const url = new URL(path, baseUrl);
        const response = await fetch(url);
        if (!response.ok) {
            throw new ProcessingLoadError(element, `Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }
        return {
            path,
            url: String(url),
            content: await response.text(),
        };
    }));
}
function parseSourceList(src) {
    return src.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
}
function normalizeSources(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new TypeError("Expected at least one Processing source");
    }
    return sources.map((source, index) => {
        if (typeof source === "string") {
            return {
                path: index === 0 ? "sketch.pde" : `sketch${index + 1}.pde`,
                content: source,
            };
        }
        if (source == null || typeof source.content !== "string") {
            throw new TypeError("Processing sources must be strings or { path, content } objects");
        }
        return {
            path: source.path ?? source.name ?? (index === 0 ? "sketch.pde" : `sketch${index + 1}.pde`),
            url: source.url,
            content: source.content,
        };
    });
}
async function getCoreArchive(options = {}) {
    const source = options.coreArchive ?? options.core ?? options.coreUrl ?? DEFAULT_CORE_URL;
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
        return toBytes(source);
    }
    if (source === DEFAULT_CORE_URL && coreArchivePromise) {
        return coreArchivePromise;
    }
    const promise = readBinary(source);
    if (source === DEFAULT_CORE_URL) {
        coreArchivePromise = promise;
    }
    return await promise;
}
function createLauncherSource(launcherClass, sketchClass, backend = BACKEND_P5) {
    const platformClass = backend === BACKEND_CANVAS2D ? "Canvas2DPlatform" : "P5Platform";
    const installCall = backend === BACKEND_CANVAS2D
        ? "Canvas2DPlatform.install(runtime)"
        : "P5Platform.installP5(runtime)";
    return `import org.teavm.jso.JSExport;
import org.teavm.jso.JSObject;
import processing.core.PApplet;
import processing.platform.teavm.${platformClass};

public class ${launcherClass} {
  public static void main(String[] args) {
  }

  @JSExport
  public static Object start(JSObject runtime) {
    ${installCall};
    ${sketchClass} sketch = new ${sketchClass}();
    PApplet.runSketch(sketch);
    return sketch;
  }
}
`;
}
function createProcessingMapper(preprocessed, sources) {
    const combined = combineSources(sources);
    const lineStarts = computeLineStarts(combined.content);
    const tabs = preprocessed.tabs.map((tab, index) => ({
        ...tab,
        source: sources[index] ?? sources.find((source) => source.path === tab.path),
        nextCharStart: preprocessed.tabs[index + 1]?.charStart ?? combined.content.length,
    }));
    const offsetMapper = buildOffsetMapper(combined.content.length, preprocessed.edits);
    return {
        sources,
        combined,
        preprocessed,
        mapGenerated(line, column = 0) {
            const generatedOffset = lineColumnToOffset(preprocessed.javaSource, line, column);
            if (generatedOffset < 0) {
                return null;
            }
            const inputOffset = offsetMapper.getInputOffset(generatedOffset);
            if (inputOffset < 0) {
                return null;
            }
            const tab = findTabAtOffset(tabs, inputOffset);
            if (!tab?.source) {
                return null;
            }
            const inputLine = offsetToLine(lineStarts, inputOffset);
            const inputColumn = inputOffset - lineStarts[inputLine];
            return {
                source: tab.source.path,
                url: tab.source.url,
                content: tab.source.content,
                line: inputLine - tab.lineStart,
                column: inputColumn,
            };
        },
    };
}
function createPreprocessDiagnostics(preprocessed) {
    const tabs = Array.from(preprocessed.tabs ?? []);
    return Array.from(preprocessed.issues ?? []).map((issue) => {
        const globalLine = Math.max(0, Number(issue.line ?? 1) - 1);
        const column = Math.max(0, Number(issue.column ?? 0));
        const tab = findTabAtLine(tabs, globalLine);
        const lineNumber = tab ? globalLine - tab.lineStart + 1 : globalLine + 1;
        return {
            type: "processing-preprocess",
            severity: "error",
            fileName: tab?.path ?? preprocessed.sourceFileName ?? "sketch.pde",
            lineNumber,
            columnNumber: column + 1,
            message: issue.message ?? "Processing syntax error",
            issue,
        };
    });
}
function combineSources(sources) {
    return {
        content: sources.map((source) => source.content).join("\n") + "\n",
    };
}
function buildOffsetMapper(inputLength, edits) {
    const inEdits = edits.map(copyEdit).sort((a, b) => a.fromOffset - b.fromOffset);
    const outEdits = edits.map(copyEdit).sort((a, b) => a.toOffset - b.toOffset);
    const inMap = [];
    const outMap = [];
    let inIndex = 0;
    let outIndex = 0;
    let inEdit = inEdits[inIndex] ?? null;
    let outEdit = outEdits[outIndex] ?? null;
    let inEditOffset = inEdit?.fromOffset ?? inputLength;
    let outEditOffset = outEdit?.toOffset ?? inputLength;
    let inOffset = 0;
    let outOffset = 0;
    while (inOffset < inputLength || inEdit != null || outEdit != null) {
        const nextEditOffset = Math.min(inEditOffset, outEditOffset);
        const length = nextEditOffset - inOffset;
        if (length > 0) {
            const move = {
                fromOffset: inOffset,
                fromLength: length,
                toOffset: outOffset,
                toLength: length,
                text: null,
            };
            inMap.push(move);
            outMap.push(move);
        }
        outOffset += nextEditOffset - inOffset;
        inOffset = nextEditOffset;
        while (inEdit != null && inOffset >= inEditOffset) {
            inOffset += inEdit.fromLength;
            if (inEdit.fromLength > 0) {
                inMap.push(inEdit);
            }
            inIndex++;
            inEdit = inEdits[inIndex] ?? null;
            inEditOffset = inEdit?.fromOffset ?? inputLength;
        }
        while (outEdit != null && inOffset >= outEditOffset) {
            outEdit.toOffset = outOffset;
            if (outEdit.toLength > 0) {
                outMap.push(outEdit);
            }
            outOffset += outEdit.toLength;
            outIndex++;
            outEdit = outEdits[outIndex] ?? null;
            outEditOffset = outEdit?.toOffset ?? inputLength;
        }
    }
    const inputStart = inMap.find((edit) => edit.fromLength > 0);
    const outputOffsetOfInputStart = inputStart?.toOffset ?? 0;
    return {
        getInputOffset(outputOffset) {
            if (outputOffset < outputOffsetOfInputStart || outMap.length === 0) {
                return -1;
            }
            const index = findEditByOutputOffset(outMap, outputOffset);
            const edit = outMap[index];
            const diff = outputOffset - edit.toOffset;
            return edit.fromOffset + Math.min(diff, Math.max(0, edit.fromLength - 1));
        },
    };
}
function copyEdit(edit) {
    return {
        fromOffset: edit.fromOffset,
        fromLength: edit.fromLength,
        toOffset: edit.toOffset,
        toLength: edit.toLength,
        text: edit.text ?? null,
    };
}
function findEditByOutputOffset(outMap, outputOffset) {
    let low = 0;
    let high = outMap.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (outMap[mid].toOffset <= outputOffset) {
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return Math.max(0, Math.min(high, outMap.length - 1));
}
function findTabAtOffset(tabs, offset) {
    let current = null;
    for (const tab of tabs) {
        if (tab.charStart <= offset && offset < tab.nextCharStart) {
            return tab;
        }
        if (tab.charStart <= offset) {
            current = tab;
        }
    }
    return current;
}
function findTabAtLine(tabs, line) {
    let current = null;
    for (let index = 0; index < tabs.length; index++) {
        const tab = tabs[index];
        const nextLineStart = tabs[index + 1]?.lineStart ?? tab.lineStart + tab.lineCount;
        if (tab.lineStart <= line && line < nextLineStart) {
            return tab;
        }
        if (tab.lineStart <= line) {
            current = tab;
        }
    }
    return current;
}
function mapDiagnostic(diagnostic, mapper) {
    if (diagnostic.lineNumber == null || diagnostic.lineNumber < 1) {
        return diagnostic;
    }
    const mapped = mapper.mapGenerated(diagnostic.lineNumber - 1, Math.max(0, (diagnostic.columnNumber ?? 1) - 1));
    if (!mapped) {
        return diagnostic;
    }
    return {
        ...diagnostic,
        generatedFileName: diagnostic.fileName,
        generatedLineNumber: diagnostic.lineNumber,
        generatedColumnNumber: diagnostic.columnNumber,
        fileName: mapped.source,
        sourceUrl: mapped.url,
        lineNumber: mapped.line + 1,
        columnNumber: mapped.column + 1,
    };
}
export function composeTeaVmSourceMap(compilerSourceMapText, mapper, preprocessed) {
    if (!compilerSourceMapText) {
        return null;
    }
    let sourceMap;
    try {
        sourceMap = JSON.parse(compilerSourceMapText);
    }
    catch {
        return compilerSourceMapText;
    }
    const decoded = decodeMappings(sourceMap.mappings ?? "");
    const sources = [];
    const sourcesContent = [];
    const sourceIndexByName = new Map();
    const addSource = (name, content = null) => {
        if (sourceIndexByName.has(name)) {
            return sourceIndexByName.get(name);
        }
        const index = sources.length;
        sourceIndexByName.set(name, index);
        sources.push(name);
        sourcesContent.push(content);
        return index;
    };
    const outputLines = decoded.map((segments) => segments.map((segment) => {
        if (segment.source == null) {
            return { ...segment };
        }
        const compilerSource = sourceMap.sources?.[segment.source] ?? "";
        if (!sameSourceName(compilerSource, preprocessed.sourceFileName)) {
            return {
                ...segment,
                source: addSource(compilerSource, sourceMap.sourcesContent?.[segment.source] ?? null),
            };
        }
        const mapped = mapper.mapGenerated(segment.originalLine, segment.originalColumn ?? 0);
        if (!mapped) {
            return {
                ...segment,
                source: addSource(compilerSource, preprocessed.javaSource),
            };
        }
        return {
            ...segment,
            source: addSource(mapped.source, mapped.content),
            originalLine: mapped.line,
            originalColumn: mapped.column,
        };
    }));
    return JSON.stringify({
        ...sourceMap,
        sources,
        sourcesContent,
        mappings: encodeMappings(outputLines),
    });
}
function sameSourceName(left, right) {
    return String(left).split(/[\\/]/).pop() === String(right).split(/[\\/]/).pop();
}
export function inlineSourceMap(text, sourceMapText) {
    if (!sourceMapText) {
        return text;
    }
    const encoded = base64EncodeUtf8(sourceMapText);
    const withoutExternalMap = text.replace(/\n?\/\/# sourceMappingURL=.*$/m, "");
    return `${withoutExternalMap}\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
}
function decodeMappings(mappings) {
    const lines = [];
    let index = 0;
    let generatedLine = 0;
    let previousGeneratedColumn = 0;
    let previousSource = 0;
    let previousOriginalLine = 0;
    let previousOriginalColumn = 0;
    let previousName = 0;
    while (index <= mappings.length) {
        if (index === mappings.length || mappings[index] === ";") {
            lines.push([]);
            generatedLine++;
            previousGeneratedColumn = 0;
            index++;
            continue;
        }
        if (mappings[index] === ",") {
            index++;
            continue;
        }
        let value;
        [value, index] = decodeVlq(mappings, index);
        previousGeneratedColumn += value;
        const segment = { generatedLine, generatedColumn: previousGeneratedColumn };
        if (index < mappings.length && mappings[index] !== "," && mappings[index] !== ";") {
            [value, index] = decodeVlq(mappings, index);
            previousSource += value;
            segment.source = previousSource;
            [value, index] = decodeVlq(mappings, index);
            previousOriginalLine += value;
            segment.originalLine = previousOriginalLine;
            [value, index] = decodeVlq(mappings, index);
            previousOriginalColumn += value;
            segment.originalColumn = previousOriginalColumn;
            if (index < mappings.length && mappings[index] !== "," && mappings[index] !== ";") {
                [value, index] = decodeVlq(mappings, index);
                previousName += value;
                segment.name = previousName;
            }
        }
        lines[generatedLine] ??= [];
        lines[generatedLine].push(segment);
    }
    return lines;
}
function encodeMappings(lines) {
    let mappings = "";
    let previousSource = 0;
    let previousOriginalLine = 0;
    let previousOriginalColumn = 0;
    let previousName = 0;
    for (let line = 0; line < lines.length; line++) {
        if (line > 0) {
            mappings += ";";
        }
        let previousGeneratedColumn = 0;
        const segments = lines[line] ?? [];
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (i > 0) {
                mappings += ",";
            }
            mappings += encodeVlq(segment.generatedColumn - previousGeneratedColumn);
            previousGeneratedColumn = segment.generatedColumn;
            if (segment.source != null) {
                mappings += encodeVlq(segment.source - previousSource);
                previousSource = segment.source;
                mappings += encodeVlq(segment.originalLine - previousOriginalLine);
                previousOriginalLine = segment.originalLine;
                mappings += encodeVlq((segment.originalColumn ?? 0) - previousOriginalColumn);
                previousOriginalColumn = segment.originalColumn ?? 0;
                if (segment.name != null) {
                    mappings += encodeVlq(segment.name - previousName);
                    previousName = segment.name;
                }
            }
        }
    }
    return mappings;
}
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map(Array.from(BASE64_CHARS, (ch, index) => [ch, index]));
function decodeVlq(text, index) {
    let result = 0;
    let shift = 0;
    let continuation;
    do {
        const digit = BASE64_VALUES.get(text[index++]);
        continuation = digit & 32;
        result += (digit & 31) << shift;
        shift += 5;
    } while (continuation);
    const negative = result & 1;
    result >>= 1;
    return [negative ? -result : result, index];
}
function encodeVlq(value) {
    let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
    let result = "";
    do {
        let digit = vlq & 31;
        vlq >>>= 5;
        if (vlq > 0) {
            digit |= 32;
        }
        result += BASE64_CHARS[digit];
    } while (vlq > 0);
    return result;
}
function lineColumnToOffset(text, line, column) {
    const starts = computeLineStarts(text);
    if (line < 0 || line >= starts.length) {
        return -1;
    }
    return Math.min(starts[line] + column, text.length);
}
function computeLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
            starts.push(i + 1);
        }
    }
    return starts;
}
function offsetToLine(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= offset) {
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return Math.max(0, high);
}
function normalizePixelDensity(value) {
    const fallback = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const density = Number(value ?? fallback);
    return Math.max(1, Math.round(Number.isFinite(density) ? density : 1));
}
function canvasContextOptions(options) {
    const contextOptions = {
        alpha: options.alpha !== false,
    };
    if (options.desynchronized != null) {
        contextOptions.desynchronized = Boolean(options.desynchronized);
    }
    return contextOptions;
}
function rgba(r, g, b, a) {
    return `rgba(${clamp255(r)},${clamp255(g)},${clamp255(b)},${clampAlpha(a)})`;
}
function clamp255(value) {
    return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}
function clampAlpha(value) {
    return Math.max(0, Math.min(1, (Number(value) || 0) / 255));
}
function extractAlpha(style) {
    const match = /rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)/.exec(style);
    return match ? Math.max(0, Math.min(1, Number(match[1]) || 0)) : 1;
}
function normalizeLineCap(value) {
    switch (value) {
        case "round":
            return "round";
        case "square":
        case "project":
            return "square";
        default:
            return "butt";
    }
}
function normalizeLineJoin(value) {
    switch (value) {
        case "round":
            return "round";
        case "bevel":
            return "bevel";
        default:
            return "miter";
    }
}
function normalizeTextAlign(value) {
    switch (value) {
        case "center":
            return "center";
        case "right":
            return "right";
        default:
            return "left";
    }
}
function java2DTextCoordinate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return 0;
    }
    return numeric < 0 ? Math.ceil(numeric + 0.5) : Math.floor(numeric + 0.5);
}
function finitePositive(value) {
    return Number.isFinite(value) && value > 0 ? value : null;
}
function normalizeTextBaseline(value) {
    switch (value) {
        case "top":
            return "top";
        case "bottom":
            return "bottom";
        case "center":
            return "middle";
        case "alphabetic":
        default:
            return "alphabetic";
    }
}
function normalizeBlendMode(value) {
    switch (value) {
        case "replace":
            return "copy";
        case "add":
            return "lighter";
        case "lightest":
            return "lighten";
        case "darkest":
            return "darken";
        case "difference":
            return "difference";
        case "exclusion":
            return "exclusion";
        case "multiply":
            return "multiply";
        case "screen":
            return "screen";
        case "overlay":
            return "overlay";
        case "hard_light":
            return "hard-light";
        case "soft_light":
            return "soft-light";
        case "dodge":
            return "color-dodge";
        case "burn":
            return "color-burn";
        case "blend":
        default:
            return "source-over";
    }
}
function cssFontFamily(font) {
    const name = String(font ?? "sans-serif").trim();
    if (!name) {
        return "sans-serif";
    }
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace)$/i.test(name)) {
        return name;
    }
    return `"${name.replace(/"/g, '\\"')}", sans-serif`;
}
function roundedRectPath(context, x, y, width, height, tl, tr, br, bl) {
    const right = x + width;
    const bottom = y + height;
    const radii = [tl, tr, br, bl].map((value) => Math.max(0, Number(value) || 0));
    context.moveTo(x + radii[0], y);
    context.lineTo(right - radii[1], y);
    context.quadraticCurveTo(right, y, right, y + radii[1]);
    context.lineTo(right, bottom - radii[2]);
    context.quadraticCurveTo(right, bottom, right - radii[2], bottom);
    context.lineTo(x + radii[3], bottom);
    context.quadraticCurveTo(x, bottom, x, bottom - radii[3]);
    context.lineTo(x, y + radii[0]);
    context.quadraticCurveTo(x, y, x + radii[0], y);
    context.closePath();
}
function nativeImageSource(image) {
    if (!image) {
        return null;
    }
    if (image.canvas) {
        return image.canvas;
    }
    if (image.elt) {
        return image.elt;
    }
    return image;
}
function createNativeImage(ownerDocument, width, height) {
    const canvas = ownerDocument.createElement("canvas");
    const image = {
        canvas,
        elt: canvas,
        width: Math.max(1, Math.round(Number(width) || 1)),
        height: Math.max(1, Math.round(Number(height) || 1)),
        pixels: null,
        imageData: null,
        loadPixels() {
            const context = canvas.getContext("2d");
            image.imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            image.pixels = image.imageData.data;
        },
        updatePixels() {
            if (!image.imageData) {
                return;
            }
            canvas.getContext("2d").putImageData(image.imageData, 0, 0);
        },
        resize(nextWidth, nextHeight) {
            const oldCanvas = ownerDocument.createElement("canvas");
            oldCanvas.width = canvas.width;
            oldCanvas.height = canvas.height;
            oldCanvas.getContext("2d").drawImage(canvas, 0, 0);
            image.width = Math.max(1, Math.round(Number(nextWidth) || image.width));
            image.height = Math.max(1, Math.round(Number(nextHeight) || image.height));
            canvas.width = image.width;
            canvas.height = image.height;
            canvas.getContext("2d").drawImage(oldCanvas, 0, 0, image.width, image.height);
            image.imageData = null;
            image.pixels = null;
        },
    };
    canvas.width = image.width;
    canvas.height = image.height;
    return image;
}
async function readBinary(input) {
    if (input == null) {
        throw new TypeError("Expected a URL, ArrayBuffer, or typed array");
    }
    if (typeof input === "string" || input instanceof URL) {
        const response = await fetch(input);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${input}: ${response.status} ${response.statusText}`);
        }
        return new Int8Array(await response.arrayBuffer());
    }
    return toBytes(input);
}
function toBytes(input) {
    if (input instanceof Int8Array) {
        return input;
    }
    if (input instanceof ArrayBuffer) {
        return new Int8Array(input);
    }
    if (ArrayBuffer.isView(input)) {
        return new Int8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError("Expected an ArrayBuffer or typed array");
}
function isBinaryInput(input) {
    return input instanceof ArrayBuffer || ArrayBuffer.isView(input);
}
function toPlainDiagnostic(diagnostic) {
    return {
        type: diagnostic.type,
        severity: diagnostic.severity,
        fileName: diagnostic.fileName,
        lineNumber: diagnostic.lineNumber,
        columnNumber: diagnostic.columnNumber,
        message: diagnostic.message,
    };
}
function normalizeOutputRequest(output) {
    const normalized = String(output ?? OUTPUT_AUTO).toLowerCase().replace(/[-_\s]/g, "");
    switch (normalized) {
        case "auto":
        case "best":
        case "default":
            return OUTPUT_AUTO;
        default:
            return normalizeConcreteOutput(output);
    }
}
function normalizeConcreteOutput(output) {
    const normalized = String(output ?? OUTPUT_WASM_GC).toLowerCase().replace(/[-_\s]/g, "");
    switch (normalized) {
        case "js":
        case "javascript":
        case "ecmascript":
        case "module":
        case "esm":
            return OUTPUT_JS;
        case "wasm":
        case "webassembly":
        case "wasmgc":
        case "webassemblygc":
            return OUTPUT_WASM_GC;
        default:
            throw new Error(`Unsupported Processing output target: ${output}`);
    }
}
function isAutomaticOutput(output) {
    return normalizeOutputRequest(output) === OUTPUT_AUTO;
}
function normalizeWasmOutputName(name) {
    const outputName = String(name ?? DEFAULT_WASM_NAME).trim() || DEFAULT_WASM_NAME;
    return outputName.endsWith(".wasm") ? outputName.slice(0, -".wasm".length) : outputName;
}
function normalizeSketchBackend(backend) {
    const normalized = String(backend ?? BACKEND_P5).toLowerCase().replace(/[-_\s]/g, "");
    switch (normalized) {
        case "p5":
        case "p5js":
            return BACKEND_P5;
        case "canvas":
        case "canvas2d":
        case "directcanvas":
        case "directcanvas2d":
            return BACKEND_CANVAS2D;
        default:
            throw new Error(`Unsupported Processing backend: ${backend}`);
    }
}
function firstSourceBaseName(path) {
    const name = String(path ?? "ProcessingSketch").split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
    return name || "ProcessingSketch";
}
function toJavaIdentifier(value) {
    let identifier = String(value ?? "ProcessingSketch").replace(/^[^A-Za-z_$]/, "_").replace(/[^A-Za-z0-9_$]/g, "_");
    if (!identifier) {
        identifier = "ProcessingSketch";
    }
    return identifier;
}
function setState(element, state) {
    element.dataset.processingState = state;
}
function base64EncodeUtf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
export class ProcessingLoadError extends Error {
    element;
    constructor(element, message) {
        super(message);
        this.name = "ProcessingLoadError";
        this.element = element;
    }
}
export class ProcessingPreprocessError extends Error {
    preprocessed;
    issues;
    diagnostics;
    constructor(preprocessed, diagnostics = createPreprocessDiagnostics(preprocessed)) {
        super(preprocessed.issues[0]?.message ?? "Processing preprocessing failed");
        this.name = "ProcessingPreprocessError";
        this.preprocessed = preprocessed;
        this.issues = preprocessed.issues;
        this.diagnostics = diagnostics;
    }
}
export class ProcessingCompileError extends Error {
    element;
    compiled;
    diagnostics;
    preprocessed;
    constructor(element, message, compiled) {
        super(message);
        this.name = "ProcessingCompileError";
        this.element = element;
        this.compiled = compiled;
        this.diagnostics = compiled?.diagnostics ?? [];
        this.preprocessed = compiled?.preprocessed;
    }
}
