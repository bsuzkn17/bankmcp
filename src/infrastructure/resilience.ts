import {
  BankAdapterError,
  CircuitOpenError,
  ConfigurationError,
  DomainError,
  RateLimitError,
} from '../domain/errors.js';

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
}

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  providerId: string,
  correlationId?: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(
      new RangeError('timeoutMs must be a non-negative finite number.'),
    );
  }

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BankAdapterError(providerId, correlationId)),
      timeoutMs,
    );
  });

  return Promise.race([Promise.resolve().then(operation), timeout]).finally(
    () => clearTimeout(timer),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonRetryableError(error: unknown): boolean {
  if (
    error instanceof CircuitOpenError ||
    error instanceof ConfigurationError
  ) {
    return true;
  }

  if (error instanceof RateLimitError) {
    return false;
  }

  if (error instanceof DomainError) {
    return error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429;
  }

  if (!isRecord(error)) {
    return false;
  }

  const statusCode = error.statusCode;
  return (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 429
  );
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof RateLimitError) {
    return error.retryAfterMs;
  }

  if (!isRecord(error)) {
    return undefined;
  }

  const retryAfterMs = error.retryAfterMs;
  return typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
    ? retryAfterMs
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxRetries,
    initialDelayMs = 100,
    maxDelayMs = 10_000,
    jitterFactor = 0.2,
  } = options;

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('maxRetries must be a non-negative integer.');
  }
  if (
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < 0
  ) {
    throw new RangeError('Retry delays must be non-negative finite numbers.');
  }
  if (!Number.isFinite(jitterFactor) || jitterFactor < 0 || jitterFactor > 1) {
    throw new RangeError('jitterFactor must be between 0 and 1.');
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (isNonRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }

      const retryAfterMs = getRetryAfterMs(error);
      if (retryAfterMs !== undefined) {
        await delay(retryAfterMs);
        continue;
      }

      const exponentialDelay = Math.min(
        initialDelayMs * 2 ** attempt,
        maxDelayMs,
      );
      const jitterMultiplier =
        1 - jitterFactor + Math.random() * jitterFactor * 2;
      await delay(Math.round(exponentialDelay * jitterMultiplier));
    }
  }
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private openedAt = 0;
  private halfOpenAttemptInProgress = false;

  public constructor(
    private readonly providerId: string,
    private readonly failureThreshold: number,
    private readonly resetTimeoutMs: number,
  ) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer.');
    }
    if (!Number.isFinite(resetTimeoutMs) || resetTimeoutMs < 0) {
      throw new RangeError(
        'resetTimeoutMs must be a non-negative finite number.',
      );
    }
  }

  public async execute<T>(
    operation: () => Promise<T>,
    correlationId?: string,
  ): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt < this.resetTimeoutMs) {
        throw new CircuitOpenError(correlationId);
      }
      this.state = 'HALF_OPEN';
    }

    const isHalfOpenAttempt = this.state === 'HALF_OPEN';
    if (isHalfOpenAttempt) {
      if (this.halfOpenAttemptInProgress) {
        throw new CircuitOpenError(correlationId);
      }
      this.halfOpenAttemptInProgress = true;
    }

    try {
      const result = await operation();
      this.failureCount = 0;
      if (isHalfOpenAttempt) {
        this.state = 'CLOSED';
      }
      return result;
    } catch (error: unknown) {
      if (isHalfOpenAttempt) {
        this.state = 'OPEN';
        this.openedAt = Date.now();
      } else {
        this.failureCount += 1;
        if (this.failureCount >= this.failureThreshold) {
          this.state = 'OPEN';
          this.openedAt = Date.now();
        }
      }
      throw error;
    } finally {
      if (isHalfOpenAttempt) {
        this.halfOpenAttemptInProgress = false;
      }
    }
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.openedAt = 0;
    this.halfOpenAttemptInProgress = false;
  }
}
