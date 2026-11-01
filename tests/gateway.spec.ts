import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnvConfig } from '../src/config/env.schema.js';
import {
  BankAdapterError,
  CircuitOpenError,
  ConfigurationError,
} from '../src/domain/errors.js';
import type {
  BankAccount,
  BankTransaction,
  Money,
  TransactionFilter,
} from '../src/domain/models.js';
import {
  createToolHandlers,
} from '../src/presentation/mcp/tool-registry.js';
import { Logger } from '../src/infrastructure/observability/logger.js';
import {
  maskCardNumber,
  maskIban,
  maskTckn,
  sanitizeData,
  sanitizeText,
} from '../src/infrastructure/security/sanitizer.js';
import {
  CircuitBreaker,
} from '../src/infrastructure/resilience.js';
import {
  OAuthBankAdapterBase,
  type OAuthAdapterConfig,
} from '../src/infrastructure/adapters/oauth-bank-adapter.base.js';
import { GarantiBankAdapter } from '../src/infrastructure/adapters/garanti.adapter.js';

const adapterConfig: OAuthAdapterConfig = {
  clientId: '',
  clientSecret: '',
  baseUrl: 'https://apis.garantibbva.com.tr',
  tokenUrl: 'https://apis.garantibbva.com.tr/oauth2/token',
  timeoutMs: 1000,
  failureThreshold: 2,
  resetTimeoutMs: 100,
  enableMockMode: true,
};

class ExposedOAuthAdapter extends OAuthBankAdapterBase {
  public constructor(config: OAuthAdapterConfig) {
    super('test-bank', 'Test Bank', config, new Logger('error'));
  }

  public get(path: string): Promise<unknown> {
    return this.requestGet(path);
  }

  protected override async fetchAccountsFromApi(): Promise<readonly BankAccount[]> {
    return [];
  }

  protected override async fetchAccountDetailsFromApi(): Promise<BankAccount> {
    return {
      id: 'test-account',
      iban: 'TR120006200000000012345678',
      maskedIban: 'TR12****************5678',
      accountName: 'Test',
      accountType: 'VADESIZ',
      balance: { amount: 0, currency: 'TRY' },
      isActive: true,
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
  }

  protected override async fetchAccountBalanceFromApi(): Promise<Money> {
    return { amount: 0, currency: 'TRY' };
  }

  protected override async fetchTransactionsFromApi(
    _filter: TransactionFilter,
  ): Promise<readonly BankTransaction[]> {
    return [];
  }

  protected override async pingApi(): Promise<void> {}
}

function decodeToolResult(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): unknown {
  const textContent = result.content.find((item) => item.type === 'text');
  if (textContent?.text === undefined) {
    throw new Error('Tool result did not contain text.');
  }
  return JSON.parse(textContent.text) as unknown;
}

describe('sanitizer and PII masking', () => {
  it('masks IBAN while preserving country, check digits, and last four', () => {
    const iban = 'TR120006200000000012345678';
    const masked = maskIban(iban);

    expect(masked).toMatch(/^TR12\*+5678$/);
    expect(masked).not.toContain(iban);
  });

  it('masks PAN leaving only its last four digits', () => {
    const pan = '4111 1111 1111 1111';
    const masked = maskCardNumber(pan);

    expect(masked).toBe('**** **** **** 1111');
    expect(masked).not.toContain('4111 1111');
  });

  it('masks TCKN, bearer tokens, JWTs, and secret object values', () => {
    const tckn = '12345678912';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const bearerToken = 'Bearer super-secret-access-value';
    const safeText = sanitizeText(
      `${bearerToken}; ${jwt}; TR120006200000000012345678`,
    );
    const safeData = sanitizeData({
      access_token: 'raw-access-token',
      client_secret: 'raw-client-secret',
      identityNumber: tckn,
    });

    expect(maskTckn(tckn)).toBe('*********12');
    expect(safeText).not.toContain('super-secret-access-value');
    expect(safeText).not.toContain(jwt);
    expect(safeText).toContain('TR12');
    expect(safeText).toContain('5678');
    expect(JSON.stringify(safeData)).not.toContain('raw-access-token');
    expect(JSON.stringify(safeData)).not.toContain('raw-client-secret');
    expect(safeData).toEqual({
      access_token: '[REDACTED]',
      client_secret: '[REDACTED]',
      identityNumber: '*********12',
    });
  });
});

describe('AISP boundary and endpoint guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('locks payment, transfer, and card management capabilities to false', () => {
    const adapter = new GarantiBankAdapter(adapterConfig, new Logger('error'));

    expect(adapter.capabilities.supportsPayments).toBe(false);
    expect(adapter.capabilities.supportsTransfers).toBe(false);
    expect(adapter.capabilities.supportsCardManagement).toBe(false);
  });

  it.each(['/transfer', '/accounts/payment'])(
    'rejects PISP endpoint %s without sending an HTTP request',
    async (path) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const adapter = new ExposedOAuthAdapter(adapterConfig);

      await expect(adapter.get(path)).rejects.toBeInstanceOf(BankAdapterError);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe('OAuth and bank API failure diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports OAuth status and sanitized provider payload without credentials', async () => {
    const config: OAuthAdapterConfig = {
      ...adapterConfig,
      enableMockMode: false,
      clientId: 'configured-client-id',
      clientSecret: 'configured-client-secret',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'OAuth client authentication failed.',
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        { status: 401, statusText: 'Unauthorized' },
      ),
    );
    const logger = new Logger('error');
    const errorLogSpy = vi.spyOn(logger, 'error');
    const adapter = new ExposedOAuthAdapter(config);

    let caughtError: unknown;
    try {
      await adapter.get('/accounts');
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(BankAdapterError);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(caughtError).toMatchObject({
      stage: 'oauth_token',
      providerStatusCode: 401,
      providerStatusText: 'Unauthorized',
    });
    const safeError = JSON.stringify(
      caughtError instanceof BankAdapterError
        ? caughtError.toSafeJSON()
        : caughtError,
    );
    expect(safeError).toContain('invalid_client');
    expect(safeError).toContain('OAuth client authentication failed.');
    expect(safeError).not.toContain(config.clientId);
    expect(safeError).not.toContain(config.clientSecret);
    expect(JSON.stringify(errorLogSpy.mock.calls)).not.toContain(
      config.clientSecret,
    );
  });

  it('reports accounts API failures separately and redacts echoed access tokens', async () => {
    const config: OAuthAdapterConfig = {
      ...adapterConfig,
      enableMockMode: false,
      clientId: 'configured-client-id',
      clientSecret: 'configured-client-secret',
    };
    const accessToken = 'access-token-secret-value';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'insufficient_scope',
            error_description: 'The accounts scope is not enabled.',
            access_token: accessToken,
            client_id: config.clientId,
            username: 'test-customer',
          }),
          { status: 403, statusText: 'Forbidden' },
        ),
      );
    const logger = new Logger('error');
    const errorLogSpy = vi.spyOn(logger, 'error');
    const adapter = new ExposedOAuthAdapter(config);

    let caughtError: unknown;
    try {
      await adapter.get('/accounts');
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(BankAdapterError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(caughtError).toMatchObject({
      stage: 'bank_api',
      providerStatusCode: 403,
      providerStatusText: 'Forbidden',
    });
    const safeError = JSON.stringify(
      caughtError instanceof BankAdapterError
        ? caughtError.toSafeJSON()
        : caughtError,
    );
    expect(safeError).toContain('insufficient_scope');
    expect(safeError).toContain('The accounts scope is not enabled.');
    expect(safeError).not.toContain(accessToken);
    expect(safeError).not.toContain(config.clientId);
    expect(safeError).not.toContain(config.clientSecret);
    expect(safeError).not.toContain('test-customer');
    expect(JSON.stringify(errorLogSpy.mock.calls)).not.toContain(accessToken);
    expect(JSON.stringify(errorLogSpy.mock.calls)).not.toContain(
      config.clientSecret,
    );
  });
});

describe('resilience and circuit breaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after reaching the failure threshold and permits one successful half-open probe', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker('test-bank', 2, 100);
    const operation = vi.fn(async () => {
      throw new Error('provider failed');
    });

    await expect(breaker.execute(operation)).rejects.toThrow('provider failed');
    await expect(breaker.execute(operation)).rejects.toThrow('provider failed');
    expect(breaker.getState()).toBe('OPEN');

    const callsBeforeOpenReject = operation.mock.calls.length;
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(operation).toHaveBeenCalledTimes(callsBeforeOpenReject);

    await vi.advanceTimersByTimeAsync(100);
    const successfulProbe = vi.fn(async () => {
      expect(breaker.getState()).toBe('HALF_OPEN');
      return 'healthy';
    });

    await expect(breaker.execute(successfulProbe)).resolves.toBe('healthy');
    expect(breaker.getState()).toBe('CLOSED');
    expect(successfulProbe).toHaveBeenCalledOnce();
  });
});

describe('MCP tools with mock Garanti adapter', () => {
  const handlers = createToolHandlers(
    new GarantiBankAdapter(adapterConfig, new Logger('error')),
    new Logger('error'),
  );

  it('returns sanitized mock accounts, balance, and transactions', async () => {
    const accountsResult = await handlers.banking_list_accounts();
    const accountsPayload = decodeToolResult(accountsResult) as {
      data: BankAccount[];
      correlationId: string;
    };

    expect(accountsResult.isError).toBeUndefined();
    expect(accountsPayload.correlationId).toBeTruthy();
    expect(accountsPayload.data).toHaveLength(3);
    for (const account of accountsPayload.data) {
      expect(account.iban).toMatch(/^TR\d{2}\*+\d{4}$/);
      expect(account.maskedIban).toBe(account.iban);
      expect(account.iban).not.toMatch(/^TR\d{22,}$/);
    }

    const balanceResult = await handlers.banking_get_account_balance({
      accountId: 'garanti-try-demand-001',
    });
    const balancePayload = decodeToolResult(balanceResult) as {
      data: Money;
    };
    expect(balanceResult.isError).toBeUndefined();
    expect(balancePayload.data).toEqual({
      amount: 42500.75,
      currency: 'TRY',
    });

    const transactionsResult = await handlers.banking_get_transactions({
      accountId: 'garanti-try-demand-001',
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2025-12-31T23:59:59.999Z',
    });
    const transactionsPayload = decodeToolResult(transactionsResult) as {
      data: BankTransaction[];
    };
    expect(transactionsResult.isError).toBeUndefined();
    expect(transactionsPayload.data).toHaveLength(2);
    expect(
      JSON.stringify(transactionsPayload),
    ).not.toMatch(/access_token|client_secret|TR\d{22,}/);
  });

  it.each([
    { accountId: '../admin' },
    { accountId: '123; DROP TABLE' },
    { accountId: 'garanti-try-demand-001', extra: 'unexpected' },
  ])('rejects invalid balance arguments safely: %o', async (input) => {
    const result = await handlers.banking_get_account_balance(input);
    const payload = decodeToolResult(result) as {
      error: { code: string; message: string };
    };

    expect(result.isError).toBe(true);
    expect(payload.error).toEqual({
      code: 'INVALID_INPUT',
      message: 'Tool input is invalid.',
    });
  });

  it.each([
    { accountId: '../admin' },
    { accountId: '123; DROP TABLE' },
    { accountId: 'garanti-try-demand-001', unexpected: true },
  ])('rejects invalid transaction arguments safely: %o', async (input) => {
    const result = await handlers.banking_get_transactions(input);
    const payload = decodeToolResult(result) as {
      error: { code: string; message: string };
    };

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe('INVALID_INPUT');
    expect(payload.error.message).toBe('Tool input is invalid.');
  });

  it('returns sanitized mock account details and rejects invalid ids', async () => {
    const detailsResult = await handlers.banking_get_account_details({
      accountId: 'garanti-try-demand-001',
    });
    const detailsPayload = decodeToolResult(detailsResult) as {
      data: BankAccount;
      correlationId: string;
    };

    expect(detailsResult.isError).toBeUndefined();
    expect(detailsPayload.correlationId).toBeTruthy();
    expect(detailsPayload.data.id).toBe('garanti-try-demand-001');
    expect(detailsPayload.data.accountName).toBe('Günlük Hesabım');
    expect(detailsPayload.data.iban).toMatch(/^TR\d{2}\*+\d{4}$/);
    expect(detailsPayload.data.maskedIban).toBe(detailsPayload.data.iban);
    expect(JSON.stringify(detailsPayload)).not.toMatch(/TR\d{22,}/);

    const invalidResult = await handlers.banking_get_account_details({
      accountId: '../admin',
    });
    const invalidPayload = decodeToolResult(invalidResult) as {
      error: { code: string; message: string };
    };
    expect(invalidResult.isError).toBe(true);
    expect(invalidPayload.error).toEqual({
      code: 'INVALID_INPUT',
      message: 'Tool input is invalid.',
    });
  });
});

const CONFIG_ENV_KEYS = [
  'NODE_ENV',
  'LOG_LEVEL',
  'ACTIVE_BANK_PROVIDER',
  'CIRCUIT_BREAKER_FAILURE_THRESHOLD',
  'CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
  'API_REQUEST_TIMEOUT_MS',
  'ENABLE_MOCK_BANKS',
  'BANK_GARANTI_CLIENT_ID',
  'BANK_GARANTI_CLIENT_SECRET',
  'BANK_GARANTI_CLIENT_SECRET_FILE',
  'BANK_GARANTI_BASE_URL',
  'BANK_GARANTI_TOKEN_URL',
] as const;

describe('secret file configuration', () => {
  const previousValues = new Map<string, string | undefined>();
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    previousValues.clear();

    for (const path of createdPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function captureEnv(): void {
    for (const key of CONFIG_ENV_KEYS) {
      previousValues.set(key, process.env[key]);
    }
  }

  function seedValidEnv(): void {
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'error';
    process.env.ACTIVE_BANK_PROVIDER = 'garanti';
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '5';
    process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = '30000';
    process.env.API_REQUEST_TIMEOUT_MS = '10000';
    process.env.ENABLE_MOCK_BANKS = 'true';
    process.env.BANK_GARANTI_CLIENT_ID = 'test-client';
    process.env.BANK_GARANTI_CLIENT_SECRET = '';
    process.env.BANK_GARANTI_BASE_URL = 'https://apis.garantibbva.com.tr';
    process.env.BANK_GARANTI_TOKEN_URL =
      'https://apis.garantibbva.com.tr/oauth2/token';
    delete process.env.BANK_GARANTI_CLIENT_SECRET_FILE;
  }

  it('loads BANK_GARANTI_CLIENT_SECRET from BANK_GARANTI_CLIENT_SECRET_FILE', () => {
    captureEnv();
    seedValidEnv();

    const directory = mkdtempSync(join(tmpdir(), 'turkish-bank-mcp-'));
    createdPaths.push(directory);
    const secretFilePath = join(directory, 'client_secret');
    writeFileSync(secretFilePath, 'file-sourced-secret\n', 'utf8');

    process.env.BANK_GARANTI_CLIENT_SECRET = '';
    process.env.BANK_GARANTI_CLIENT_SECRET_FILE = secretFilePath;

    const config = loadEnvConfig();
    expect(config.BANK_GARANTI_CLIENT_SECRET).toBe('file-sourced-secret');
  });

  it('prefers an inline secret over a secret file', () => {
    captureEnv();
    seedValidEnv();

    const directory = mkdtempSync(join(tmpdir(), 'turkish-bank-mcp-'));
    createdPaths.push(directory);
    const secretFilePath = join(directory, 'client_secret');
    writeFileSync(secretFilePath, 'file-sourced-secret\n', 'utf8');

    process.env.BANK_GARANTI_CLIENT_SECRET = 'inline-secret';
    process.env.BANK_GARANTI_CLIENT_SECRET_FILE = secretFilePath;

    const config = loadEnvConfig();
    expect(config.BANK_GARANTI_CLIENT_SECRET).toBe('inline-secret');
  });

  it('throws ConfigurationError when the secret file cannot be read', () => {
    captureEnv();
    seedValidEnv();
    process.env.BANK_GARANTI_CLIENT_SECRET = '';
    process.env.BANK_GARANTI_CLIENT_SECRET_FILE = join(
      tmpdir(),
      'turkish-bank-mcp-missing-secret',
    );

    expect(() => loadEnvConfig()).toThrow(ConfigurationError);
    try {
      loadEnvConfig();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      if (error instanceof ConfigurationError) {
        expect(error.message).toBe(
          'The configured secret file could not be read.',
        );
      }
    }
  });
});
