// @ts-nocheck
let processingRuntimePromise = null;
self.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) {
        return;
    }
    if (message.command === "ping") {
        self.postMessage({ id: message.id, type: "pong" });
        return;
    }
    if (message.command !== "compile-processing") {
        return;
    }
    handleCompileProcessing(message.id, message.payload).catch((error) => {
        self.postMessage({
            id: message.id,
            type: "error",
            error: serializeError(error),
        });
    });
});
async function handleCompileProcessing(id, payload) {
    const { compileProcessingSketch, emitProcessingSketchWithFallback, } = await getProcessingRuntime();
    const options = payload.options ?? {};
    const totalStarted = now();
    self.postMessage({ id, type: "state", state: "compiling" });
    const compileStarted = now();
    const compiled = await compileProcessingSketch(payload.sources, {
        compilerOptions: options.compilerOptions,
        core: options.core,
        sourceMaps: options.sourceMaps,
        optimizationLevel: options.optimizationLevel ?? "simple",
        backend: options.backend,
        sketchName: options.sketchName,
        launcherClass: options.launcherClass,
        onDiagnostic: (diagnostic) => {
            self.postMessage({ id, type: "diagnostic", diagnostic });
        },
    });
    const compileMs = now() - compileStarted;
    const baseResult = {
        compiled: compiled.compiled,
        diagnostics: compiled.diagnostics,
        preprocessed: compiled.preprocessed,
        launcherClass: compiled.launcherClass,
        launcherSource: compiled.launcherSource,
        timings: {
            compileMs,
            totalMs: now() - totalStarted,
        },
    };
    if (!compiled.compiled) {
        self.postMessage({ id, type: "result", result: baseResult });
        return;
    }
    self.postMessage({ id, type: "state", state: "emitting" });
    const emitStarted = now();
    const emitted = await emitProcessingSketchWithFallback(compiled, {
        output: options.output,
        sourceMaps: options.sourceMaps,
        optimizationLevel: options.optimizationLevel ?? "simple",
        fastGlobalAnalysis: Boolean(options.fastGlobalAnalysis ?? options.fastDependencyAnalysis),
        wasmName: options.wasmName,
    });
    const emitMs = now() - emitStarted;
    self.postMessage({
        id,
        type: "result",
        result: {
            ...baseResult,
            ...emitted,
            diagnostics: [
                ...baseResult.diagnostics,
                ...(emitted.diagnostics ?? []),
            ],
            timings: {
                ...baseResult.timings,
                emitMs,
                totalMs: now() - totalStarted,
            },
        },
    });
}
async function getProcessingRuntime() {
    if (!processingRuntimePromise) {
        const url = new URL("./processing-teavm.js", import.meta.url);
        if (self.location?.search) {
            url.search = self.location.search;
        }
        processingRuntimePromise = import(url);
    }
    return await processingRuntimePromise;
}
function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function serializeError(error) {
    return {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stack: error?.stack,
        diagnostics: error?.diagnostics ?? [],
        issues: error?.issues ?? [],
        preprocessed: error?.preprocessed,
    };
}
export {};
