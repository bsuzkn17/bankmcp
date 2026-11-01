import type {
  AdapterCapabilities,
  BankAccount,
  BankTransaction,
  Money,
  TransactionFilter,
} from '../../domain/models.js';
import {
  BankAdapterError,
  CircuitOpenError,
  ConfigurationError,
  DomainError,
  RateLimitError,
  type SafeErrorJSON,
} from '../../domain/errors.js';
import type {
  AdapterHealthStatus,
  IBankAdapter,
} from '../../application/bank-adapter.port.js';
import {
  CircuitBreaker,
  withRetry,
  withTimeout,
} from '../resilience.js';
import { Logger } from '../observability/logger.js';
import { sanitizeData, sanitizeText } from '../security/sanitizer.js';

export interface OAuthAdapterConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  tokenUrl: string;
  timeoutMs: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  enableMockMode: boolean;
}

type ProviderRequestStage = 'oauth_token' | 'bank_api';

interface ProviderResponseDetails {
  stage: ProviderRequestStage;
  statusCode: number;
  statusText: string;
  body: unknown;
  retryAfterMs?: number;
}

interface DetailedSafeErrorJSON extends SafeErrorJSON {
  stage: ProviderRequestStage;
  providerStatusCode?: number;
  providerStatusText?: string;
  providerError?: unknown;
  retryAfterMs?: number;
}

class ProviderResponseError extends Error {
  public readonly statusCode: number;

  public constructor(public readonly details: ProviderResponseDetails) {
    super('The bank provider returned an unsuccessful response.');
    this.name = 'ProviderResponseError';
    this.statusCode = details.statusCode;
  }

  public get retryAfterMs(): number | undefined {
    return this.details.retryAfterMs;
  }
}

class UnauthorizedResponseError extends ProviderResponseError {
  public override readonly statusCode = 401;

  public constructor(details: ProviderResponseDetails) {
    super(details);
    this.name = 'UnauthorizedResponseError';
  }
}

class ProviderTransportError extends Error {
  public constructor(public readonly stage: ProviderRequestStage) {
    super('The bank provider request could not be completed.');
    this.name = 'ProviderTransportError';
  }
}

class DetailedBankAdapterError extends BankAdapterError {
  public constructor(
    providerId: string,
    correlationId: string | undefined,
    public readonly stage: ProviderRequestStage,
    public readonly providerStatusCode?: number,
    public readonly providerStatusText?: string,
    public readonly providerError?: unknown,
  ) {
    super(providerId, correlationId);
    this.message =
      stage === 'oauth_token'
        ? 'Bank OAuth token request failed.'
        : 'Bank API request failed.';
  }

  public override toSafeJSON(): DetailedSafeErrorJSON {
    return {
      ...super.toSafeJSON(),
      message: this.message,
      stage: this.stage,
      ...(this.providerStatusCode === undefined
        ? {}
        : { providerStatusCode: this.providerStatusCode }),
      ...(this.providerStatusText === undefined
        ? {}
        : { providerStatusText: this.providerStatusText }),
      ...(this.providerError === undefined
        ? {}
        : { providerError: this.providerError }),
    };
  }
}

class DetailedRateLimitError extends RateLimitError {
  public constructor(
    retryAfterMs: number,
    correlationId: string | undefined,
    public readonly stage: ProviderRequestStage,
    public readonly providerStatusCode: number,
    public readonly providerStatusText: string,
    public readonly providerError: unknown,
  ) {
    super(retryAfterMs, correlationId);
  }

  public override toSafeJSON(): DetailedSafeErrorJSON {
    return {
      ...super.toSafeJSON(),
      stage: this.stage,
      providerStatusCode: this.providerStatusCode,
      providerStatusText: this.providerStatusText,
      providerError: this.providerError,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

const MAX_PROVIDER_ERROR_BODY_LENGTH = 8_192;
const SENSITIVE_PROVIDER_FIELD =
  /(?:client[_-]?id|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|password|passcode|credential|username|user[_-]?id|api[_-]?key)/i;
const LABELED_SECRET_PATTERN =
  /((?:client[_-]?id|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|password|passcode|credential|username|user[_-]?id|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRetryAfterMs(response: Response): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) {
    return 0;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt) ? 0 : Math.max(retryAt - Date.now(), 0);
}

export abstract class OAuthBankAdapterBase implements IBankAdapter {
  public readonly capabilities: AdapterCapabilities =
    Object.freeze<AdapterCapabilities>({
      supportsAccountListing: true,
      supportsBalanceQuery: true,
      supportsTransactionHistory: true,
      supportsPayments: false,
      supportsTransfers: false,
      supportsCardManagement: false,
    });

  #cachedToken: { value: string; expiresAt: number } | null = null;
  #tokenRequest: Promise<string> | null = null;

  private readonly circuitBreaker: CircuitBreaker;

  protected constructor(
    public readonly providerId: string,
    public readonly providerName: string,
    protected readonly config: OAuthAdapterConfig,
    protected readonly logger: Logger = new Logger(),
  ) {
    this.circuitBreaker = new CircuitBreaker(
      providerId,
      config.failureThreshold,
      config.resetTimeoutMs,
    );
  }

  protected abstract fetchAccountsFromApi(
    correlationId?: string,
  ): Promise<readonly BankAccount[]>;

  protected abstract fetchAccountDetailsFromApi(
    accountId: string,
    correlationId?: string,
  ): Promise<BankAccount>;

  protected abstract fetchAccountBalanceFromApi(
    accountId: string,
    correlationId?: string,
  ): Promise<Money>;

  protected abstract fetchTransactionsFromApi(
    filter: TransactionFilter,
    correlationId?: string,
  ): Promise<readonly BankTransaction[]>;

  protected abstract pingApi(correlationId?: string): Promise<void>;

  protected async requestGet<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
    correlationId?: string,
  ): Promise<T> {
    const url = this.createApiUrl(path, query);
    let tokenRefreshed = false;

    try {
      return await this.circuitBreaker.execute(
        () =>
          withRetry(
            async () => {
              try {
                return await this.performGet<T>(url, correlationId);
              } catch (error: unknown) {
                if (
                  error instanceof UnauthorizedResponseError &&
                  !tokenRefreshed
                ) {
                  tokenRefreshed = true;
                  this.#cachedToken = null;
                  return this.performGet<T>(url, correlationId);
                }
                throw error;
              }
            },
            { maxRetries: 2 },
          ),
        correlationId,
      );
    } catch (error: unknown) {
      if (error instanceof ProviderResponseError) {
        if (error.details.statusCode === 429) {
          const rateLimitError = new DetailedRateLimitError(
            error.details.retryAfterMs ?? 0,
            correlationId,
            error.details.stage,
            error.details.statusCode,
            error.details.statusText,
            error.details.body,
          );
          this.logProviderFailure(rateLimitError);
          throw rateLimitError;
        }

        const adapterError = new DetailedBankAdapterError(
          this.providerId,
          correlationId,
          error.details.stage,
          error.details.statusCode,
          error.details.statusText,
          error.details.body,
        );
        this.logProviderFailure(adapterError);
        throw adapterError;
      }

      if (error instanceof ProviderTransportError) {
        const adapterError = new DetailedBankAdapterError(
          this.providerId,
          correlationId,
          error.stage,
        );
        this.logProviderFailure(adapterError);
        throw adapterError;
      }

      if (
        error instanceof DetailedBankAdapterError ||
        error instanceof DetailedRateLimitError
      ) {
        throw error;
      }

      if (
        error instanceof BankAdapterError ||
        error instanceof CircuitOpenError ||
        error instanceof ConfigurationError ||
        error instanceof RateLimitError
      ) {
        throw error;
      }

      throw new BankAdapterError(this.providerId, correlationId);
    }
  }

  private logProviderFailure(error: DomainError): void {
    this.logger.error('Bank provider request failed.', {
      providerId: this.providerId,
      error: sanitizeData(error.toSafeJSON()),
    });
  }

  public listAccounts(
    correlationId?: string,
  ): Promise<readonly BankAccount[]> {
    return this.observe('list_accounts', correlationId, () =>
      this.fetchAccountsFromApi(correlationId),
    );
  }

  public getAccountDetails(
    accountId: string,
    correlationId?: string,
  ): Promise<BankAccount> {
    return this.observe('get_account_details', correlationId, () =>
      this.fetchAccountDetailsFromApi(accountId, correlationId),
    );
  }

  public getAccountBalance(
    accountId: string,
    correlationId?: string,
  ): Promise<Money> {
    return this.observe('get_account_balance', correlationId, () =>
      this.fetchAccountBalanceFromApi(accountId, correlationId),
    );
  }

  public getTransactions(
    filter: TransactionFilter,
    correlationId?: string,
  ): Promise<readonly BankTransaction[]> {
    return this.observe('get_transactions', correlationId, () =>
      this.fetchTransactionsFromApi(filter, correlationId),
    );
  }

  public async checkHealth(
    correlationId?: string,
  ): Promise<AdapterHealthStatus> {
    const startedAt = Date.now();
    try {
      await this.pingApi(correlationId);
      const latencyMs = Date.now() - startedAt;
      this.logger.audit({
        toolName: 'check_health',
        providerId: this.providerId,
        correlationId: correlationId ?? '',
        outcome: 'SUCCESS',
        durationMs: latencyMs,
      });

      return {
        status: 'HEALTHY',
        providerId: this.providerId,
        latencyMs,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - startedAt;
      const safeError = this.toSafeError(error, correlationId);
      this.logger.audit({
        toolName: 'check_health',
        providerId: this.providerId,
        correlationId: correlationId ?? '',
        outcome: 'FAILURE',
        durationMs: latencyMs,
        errorCode: safeError.code,
      });
      this.logger.warn('Bank provider health check failed.', {
        providerId: this.providerId,
        correlationId,
        error: sanitizeData(safeError.toSafeJSON()),
      });

      return {
        status: 'UNREACHABLE',
        providerId: this.providerId,
        latencyMs,
        checkedAt: new Date().toISOString(),
        message: sanitizeText('Bank provider health check failed.'),
      };
    }
  }

  private async observe<T>(
    toolName: string,
    correlationId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await operation();
      this.logger.audit({
        toolName,
        providerId: this.providerId,
        correlationId: correlationId ?? '',
        outcome: 'SUCCESS',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error: unknown) {
      const safeError = this.toSafeError(error, correlationId);
      this.logger.audit({
        toolName,
        providerId: this.providerId,
        correlationId: correlationId ?? '',
        outcome: 'FAILURE',
        durationMs: Date.now() - startedAt,
        errorCode: safeError.code,
      });
      this.logger.error('Bank provider operation failed.', {
        providerId: this.providerId,
        correlationId,
        error: sanitizeData(safeError.toSafeJSON()),
      });
      throw safeError;
    }
  }

  private toSafeError(
    error: unknown,
    correlationId?: string,
  ): DomainError {
    if (
      error instanceof BankAdapterError ||
      error instanceof CircuitOpenError ||
      error instanceof ConfigurationError ||
      error instanceof RateLimitError
    ) {
      return error;
    }

    return new BankAdapterError(this.providerId, correlationId);
  }

  private createApiUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): URL {
    if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
      throw new BankAdapterError(this.providerId);
    }

    const baseUrl = new URL(this.config.baseUrl);
    if (!baseUrl.pathname.endsWith('/')) {
      baseUrl.pathname += '/';
    }

    const url = new URL(path.replace(/^\/+/, ''), baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new BankAdapterError(this.providerId);
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw new BankAdapterError(this.providerId);
    }

    if (
      /(?:transfer|payment|wire|send|card-mutation)/i.test(decodedPath)
    ) {
      throw new BankAdapterError(this.providerId);
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private async performGet<T>(
    url: URL,
    correlationId?: string,
  ): Promise<T> {
    const token = await this.getAccessToken(correlationId);
    let response: Response;
    try {
      response = await withTimeout(
        () =>
          fetch(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
          }),
        this.config.timeoutMs,
        this.providerId,
        correlationId,
      );
    } catch {
      throw new ProviderTransportError('bank_api');
    }

    if (response.status === 401) {
      throw new UnauthorizedResponseError(
        await this.getProviderResponseDetails(response, 'bank_api', [token]),
      );
    }
    if (!response.ok) {
      const details = await this.getProviderResponseDetails(
        response,
        'bank_api',
        [token],
      );
      if (response.status === 429) {
        details.retryAfterMs = getRetryAfterMs(response);
      }
      throw new ProviderResponseError(details);
    }

    try {
      const payload: unknown = await response.json();
      return payload as T;
    } catch {
      throw new BankAdapterError(this.providerId, correlationId);
    }
  }

  private async getAccessToken(correlationId?: string): Promise<string> {
    if (
      this.#cachedToken !== null &&
      this.#cachedToken.expiresAt > Date.now()
    ) {
      return this.#cachedToken.value;
    }

    if (this.#tokenRequest !== null) {
      return this.#tokenRequest;
    }

    const tokenRequest = this.fetchAccessToken(correlationId);
    this.#tokenRequest = tokenRequest;
    try {
      return await tokenRequest;
    } finally {
      if (this.#tokenRequest === tokenRequest) {
        this.#tokenRequest = null;
      }
    }
  }

  private async fetchAccessToken(correlationId?: string): Promise<string> {
    let response: Response;
    try {
      response = await withTimeout(
        () =>
          fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: this.config.clientId,
              client_secret: this.config.clientSecret,
            }),
          }),
        this.config.timeoutMs,
        this.providerId,
        correlationId,
      );
    } catch {
      throw new ProviderTransportError('oauth_token');
    }

    if (!response.ok) {
      const details = await this.getProviderResponseDetails(
        response,
        'oauth_token',
        [this.config.clientId, this.config.clientSecret],
      );
      if (response.status === 429) {
        details.retryAfterMs = getRetryAfterMs(response);
      }
      throw new ProviderResponseError(details);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    if (!isRecord(payload)) {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    const accessToken = payload.access_token;
    const expiresIn = payload.expires_in;
    if (
      typeof accessToken !== 'string' ||
      accessToken.length === 0 ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    this.#cachedToken = {
      value: accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return accessToken;
  }

  private async getProviderResponseDetails(
    response: Response,
    stage: ProviderRequestStage,
    additionalSecrets: readonly string[] = [],
  ): Promise<ProviderResponseDetails> {
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch {
      rawBody = '[Response body could not be read]';
    }

    const body = this.sanitizeProviderBody(rawBody, additionalSecrets);
    const statusText = this.redactSecretText(
      sanitizeText(response.statusText),
      additionalSecrets,
    );
    return {
      stage,
      statusCode: response.status,
      statusText,
      body,
    };
  }

  private sanitizeProviderBody(
    rawBody: string,
    additionalSecrets: readonly string[],
  ): unknown {
    const boundedBody = rawBody.slice(0, MAX_PROVIDER_ERROR_BODY_LENGTH);
    let parsedBody: unknown = boundedBody;

    try {
      parsedBody = JSON.parse(boundedBody) as unknown;
    } catch {
      parsedBody = boundedBody;
    }

    return this.redactKnownSecrets(
      sanitizeData(parsedBody),
      additionalSecrets,
    );
  }

  private redactKnownSecrets(
    value: unknown,
    additionalSecrets: readonly string[],
  ): unknown {
    if (typeof value === 'string') {
      return this.redactSecretText(sanitizeText(value), additionalSecrets);
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this.redactKnownSecrets(item, additionalSecrets),
      );
    }

    if (isRecord(value)) {
      const sanitized: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        sanitized[key] = SENSITIVE_PROVIDER_FIELD.test(key)
          ? '[REDACTED]'
          : this.redactKnownSecrets(nestedValue, additionalSecrets);
      }
      return sanitized;
    }

    return value;
  }

  private redactSecretText(
    value: string,
    additionalSecrets: readonly string[],
  ): string {
    let sanitized = value.replace(LABELED_SECRET_PATTERN, '$1[REDACTED]');
    for (const secret of [
      this.config.clientId,
      this.config.clientSecret,
      this.#cachedToken?.value ?? '',
      ...additionalSecrets,
    ]) {
      if (secret.length > 0) {
        sanitized = sanitized.split(secret).join('[REDACTED]');
      }
    }
    return sanitized;
  }
}
