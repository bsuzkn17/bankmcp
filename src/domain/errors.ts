export interface SafeErrorJSON {
  name: string;
  code: string;
  message: string;
  statusCode: number;
  isOperational: boolean;
  correlationId: string | undefined;
}

export abstract class DomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly correlationId: string | undefined;

  protected constructor(
    code: string,
    message: string,
    statusCode: number,
    isOperational: boolean,
    correlationId?: string,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.correlationId = correlationId;
  }

  public toSafeJSON(): SafeErrorJSON {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      isOperational: this.isOperational,
      correlationId: this.correlationId,
    };
  }
}

export class ConfigurationError extends DomainError {
  public constructor(correlationId?: string, message?: string) {
    super(
      'CONFIGURATION_ERROR',
      message ?? 'Required application configuration is missing or invalid.',
      500,
      false,
      correlationId,
    );
  }
}

export class BankAdapterError extends DomainError {
  public constructor(
    public readonly providerId: string,
    correlationId?: string,
  ) {
    super(
      'BANK_ADAPTER_ERROR',
      'The bank provider request failed.',
      502,
      true,
      correlationId,
    );
  }
}

export class RateLimitError extends DomainError {
  public constructor(
    public readonly retryAfterMs: number,
    correlationId?: string,
  ) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError('retryAfterMs must be a non-negative finite number.');
    }

    super(
      'RATE_LIMIT_ERROR',
      'The bank provider rate limit was exceeded.',
      429,
      true,
      correlationId,
    );
  }
}

export class CircuitOpenError extends DomainError {
  public constructor(correlationId?: string) {
    super(
      'CIRCUIT_OPEN_ERROR',
      'The bank provider circuit breaker is open.',
      503,
      true,
      correlationId,
    );
  }
}
