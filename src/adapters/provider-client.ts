import { AppError } from '../domain/errors.js';

const BASE_RETRY_DELAY_MS = 100;

export type RetryOptions = {
  maxAttempts?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'FetchError' ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('network')
    );
  }
  return false;
}

function is5xxError(error: unknown): boolean {
  if (error instanceof Error && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' && status >= 500;
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(
        'ADAPTER_TIMEOUT',
        504,
        `Operation timed out after ${String(timeoutMs)}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
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

  throw new AppError('ADAPTER_RETRY_EXHAUSTED', 502, 'Retry attempts exhausted');
}

type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryTimeMs = 30_000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.recoveryTimeMs) {
        throw new AppError('ADAPTER_CIRCUIT_OPEN', 503, 'Circuit breaker is open');
      }
      this.state = 'half-open';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}
