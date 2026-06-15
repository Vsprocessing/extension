self.onmessage = event => {
	if (event.data?.type === 'run') {
		void run(event.data);
	} else if (event.data?.type === 'file-response') {
		const request = hostRequests.get(event.data.requestId);
		if (request) {
			hostRequests.delete(event.data.requestId);
			if (event.data.error) {
				const error = new Error(event.data.error);
				error.name = event.data.errorName || 'Error';
				request.reject(error);
			} else {
				request.resolve(event.data);
			}
		}
	}
};

const send = message => self.postMessage(message);
let nextHostRequestId = 1;
const hostRequests = new Map();

function toText(value) {
	if (value instanceof Error) {
		return value.stack || `${value.name}: ${value.message}`;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
	const original = console[level].bind(console);
	console[level] = (...values) => {
		send({ type: 'log', text: values.map(toText).join(' ') });
		original(...values);
	};
}

function requestHost(type, payload = {}) {
	const requestId = nextHostRequestId++;
	send({ ...payload, type, requestId });
	return new Promise((resolve, reject) => hostRequests.set(requestId, { resolve, reject }));
}

function toBytes(value) {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function isRelativeFetchInput(input) {
	const value = typeof input === 'string'
		? input
		: input instanceof URL
			? input.href
			: input?.url;
	return typeof value === 'string'
		&& !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
		&& !value.startsWith('//');
}

function fetchPath(input) {
	const value = typeof input === 'string'
		? input
		: input instanceof URL
			? input.href
			: input.url;
	return value.replace(/^\.\/+/, '').replace(/[?#].*$/, '');
}

function installRuntimeFetch() {
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input, init) => {
		if (!isRelativeFetchInput(input)) {
			return originalFetch(input, init);
		}
		try {
			const response = await requestHost('file-open', { path: fetchPath(input) });
			return new Response(toOpenResult(response), { status: 200 });
		} catch (error) {
			if (error?.name === 'FileNotFoundError') {
				return new Response('', { status: 404, statusText: 'Not Found' });
			}
			throw error;
		}
	};
}

function toOpenResult(response) {
	return response.bytes == null ? response.bytes : toBytes(response.bytes);
}

async function run(payload) {
	try {
		const compilerModule = await import(payload.compilerUri);
		installRuntimeFetch();
		const runtimeModule = await import(payload.runtimeUri);
		if (typeof compilerModule.createJavaProgram !== 'function') {
			throw new Error('teavm-javac.js did not export createJavaProgram().');
		}
		let finished = false;
		const finish = () => {
			if (!finished) {
				finished = true;
				send({ type: 'finished' });
			}
		};
		const program = await compilerModule.createJavaProgram(new Uint8Array(payload.wasmBytes), {
			runtimeModule,
			stdio: {
				stdin: '',
				stdout: text => send({ type: 'stdout', text }),
				stderr: text => send({ type: 'stderr', text })
			},
			fs: {
				onFileWrite: (path, content) => send({ type: 'file-write', path, content }),
				onFileClose: (path, mode, content) => send({ type: 'file-close', path, mode, content })
			}
		});
		await program.execute({
			args: [],
			timeoutMs: 10000,
			onFinish: finish
		});
		finish();
	} catch (error) {
		send({ type: 'error', text: toText(error) });
	}
}
