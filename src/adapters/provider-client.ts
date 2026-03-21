import { AppError } from "../domain/errors.js";

const BASE_RETRY_DELAY_MS = 100;

export type RetryOptions = {
	maxAttempts?: number;
	shouldRetry?: (error: unknown, attempt: number) => boolean;
};

function isNetworkError(error: unknown): boolean {
	if (error instanceof Error) {
		return (
			error.name === "FetchError" ||
			error.message.includes("ECONNREFUSED") ||
			error.message.includes("ENOTFOUND") ||
			error.message.includes("network")
		);
	}
	return false;
}

function is5xxError(error: unknown): boolean {
	if (error instanceof Error && "status" in error) {
		const status = (error as { status: unknown }).status;
		return typeof status === "number" && status >= 500;
	}
	return false;
}

function defaultShouldRetry(error: unknown): boolean {
	return isNetworkError(error) || is5xxError(error);
}

function getRetryDelayMs(attempt: number): number {
	const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
	return exponentialDelay + jitter;
}

export async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function withTimeout<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	const controller = new AbortController();
	const timeoutError = new AppError(
		"ADAPTER_TIMEOUT",
		504,
		`Operation timed out after ${String(timeoutMs)}ms`,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(timeoutError);
			controller.abort();
		}, timeoutMs);
	});

	const inFlight = fn(controller.signal);

	try {
		return await Promise.race([inFlight, timeoutPromise]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	opts: RetryOptions = {},
): Promise<T> {
	const maxAttempts = opts.maxAttempts ?? 3;
	const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn();
		} catch (error) {
			if (attempt === maxAttempts || !shouldRetry(error, attempt)) {
				throw error;
			}
			await sleep(getRetryDelayMs(attempt));
		}
	}

	throw new AppError(
		"ADAPTER_RETRY_EXHAUSTED",
		502,
		"Retry attempts exhausted",
	);
}
