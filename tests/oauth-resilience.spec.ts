import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.schema.js';
import {
  BankAdapterError,
  ConfigurationError,
  RateLimitError,
} from '../src/domain/errors.js';
import type {
  BankAccount,
  BankTransaction,
  Money,
  TransactionFilter,
} from '../src/domain/models.js';
import { GarantiBankAdapter } from '../src/infrastructure/adapters/garanti.adapter.js';
import {
  OAuthBankAdapterBase,
  type OAuthAdapterConfig,
} from '../src/infrastructure/adapters/oauth-bank-adapter.base.js';
import { Logger } from '../src/infrastructure/observability/logger.js';
import { withRetry } from '../src/infrastructure/resilience.js';

const adapterConfig: OAuthAdapterConfig = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  baseUrl: 'https://apis.garantibbva.com.tr',
  tokenUrl: 'https://apis.garantibbva.com.tr/auth/oauth/v2/token',
  timeoutMs: 1000,
  failureThreshold: 5,
  resetTimeoutMs: 100,
  enableMockMode: false,
};

class TestOAuthAdapter extends OAuthBankAdapterBase {
  public constructor(config: OAuthAdapterConfig = adapterConfig) {
    super('test-bank', 'Test Bank', config, new Logger('error'));
  }

  public get(path: string): Promise<unknown> {
    return this.requestGet(path);
  }

  protected override async fetchAccountsFromApi(): Promise<
    readonly BankAccount[]
  > {
    return [];
  }

  protected override async fetchAccountDetailsFromApi(): Promise<BankAccount> {
    throw new Error('Not used in this test adapter.');
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function makeEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ACTIVE_BANK_PROVIDER: 'garanti',
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: '5',
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: '100',
    API_REQUEST_TIMEOUT_MS: '1000',
    ENABLE_MOCK_BANKS: 'true',
    BANK_GARANTI_CLIENT_ID: '',
    BANK_GARANTI_CLIENT_SECRET: '',
    BANK_GARANTI_BASE_URL: 'https://apis.garantibbva.com.tr',
    BANK_GARANTI_TOKEN_URL:
      'https://apis.garantibbva.com.tr/auth/oauth/v2/token',
    ...overrides,
  };
}

function tokenPayload(accessToken: string): Response {
  return jsonResponse({ access_token: accessToken, expires_in: 3600 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OAuth token and resilience behavior', () => {
  it('deduplicates ten concurrent token requests', async () => {
    let releaseToken: ((response: Response) => void) | undefined;
    const tokenGate = new Promise<Response>((resolve) => {
      releaseToken = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return tokenGate;
        }
        return jsonResponse([]);
      },
    );
    const adapter = new TestOAuthAdapter();

    const requests = Array.from({ length: 10 }, () => adapter.get('/accounts'));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    releaseToken?.(tokenPayload('shared-access-token'));
    await expect(Promise.all(requests)).resolves.toHaveLength(10);

    expect(
      fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  });

  it('does not cache a failed token request and retries on the next call', async () => {
    let tokenRequests = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          tokenRequests += 1;
          return tokenRequests === 1
            ? jsonResponse({ error: 'invalid_client' }, 401)
            : tokenPayload('recovered-access-token');
        }
        return jsonResponse([]);
      },
    );
    const adapter = new TestOAuthAdapter();

    await expect(adapter.get('/accounts')).rejects.toBeInstanceOf(
      BankAdapterError,
    );
    await expect(adapter.get('/accounts')).resolves.toEqual([]);
    expect(
      fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(2);
  });

  it('renews a rejected token once without deleting a concurrently refreshed token', async () => {
    const oldResponses: Array<(response: Response) => void> = [];
    let tokenRequests = 0;
    let oldTokenRequests = 0;
    let newTokenRequests = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          tokenRequests += 1;
          return tokenPayload(tokenRequests === 1 ? 'old-token' : 'new-token');
        }

        const authorization = new Headers(init?.headers).get('authorization');
        if (authorization === 'Bearer old-token') {
          oldTokenRequests += 1;
          return new Promise<Response>((resolve) => {
            oldResponses.push(resolve);
          });
        }
        newTokenRequests += 1;
        return jsonResponse([]);
      },
    );
    const adapter = new TestOAuthAdapter();

    const first = adapter.get('/accounts');
    const second = adapter.get('/accounts');
    await vi.waitFor(() => expect(oldTokenRequests).toBe(2));

    oldResponses[0]?.(jsonResponse({ error: 'expired' }, 401));
    await vi.waitFor(() => {
      expect(tokenRequests).toBe(2);
      expect(newTokenRequests).toBe(1);
    });

    oldResponses[1]?.(jsonResponse({ error: 'expired' }, 401));
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);

    expect(tokenRequests).toBe(2);
    expect(newTokenRequests).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('does not open the circuit for five consecutive 404/403 responses', async () => {
    let apiRequests = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return tokenPayload('client-error-token');
        }
        apiRequests += 1;
        const status =
          apiRequests <= 5 ? (apiRequests % 2 === 1 ? 404 : 403) : 200;
        return jsonResponse({}, status);
      },
    );
    const adapter = new TestOAuthAdapter();

    for (let index = 0; index < 5; index += 1) {
      await expect(adapter.get('/accounts')).rejects.toBeDefined();
    }
    await expect(adapter.get('/accounts')).resolves.toEqual({});
    expect(apiRequests).toBe(6);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });

  it.each([
    { label: '5xx', status: 500, transportFailure: false },
    { label: '429', status: 429, transportFailure: false },
    { label: 'transport', status: 0, transportFailure: true },
  ])(
    'opens the circuit for $label failures',
    async ({ status, transportFailure }) => {
      const config = { ...adapterConfig, failureThreshold: 1 };
      let apiRequests = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'POST') {
            return tokenPayload('failure-token');
          }
          apiRequests += 1;
          if (transportFailure) {
            throw new TypeError('network unavailable');
          }
          return jsonResponse({}, status);
        },
      );
      const adapter = new TestOAuthAdapter(config);

      await expect(adapter.get('/accounts')).rejects.toBeDefined();
      const requestsAtOpen = apiRequests;
      await expect(adapter.get('/accounts')).rejects.toBeDefined();

      expect(apiRequests).toBe(requestsAtOpen);
      expect(fetchSpy).toHaveBeenCalledTimes(requestsAtOpen + 1);
    },
  );

  it('caps Retry-After delays at maxDelayMs', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new RateLimitError(1000))
      .mockResolvedValue('retried');
    let resolved = false;
    const result = withRetry(operation, {
      maxRetries: 1,
      maxDelayMs: 25,
    }).then((value) => {
      resolved = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('retried');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('aborts fetch signals when OAuth requests time out', async () => {
    const signals: AbortSignal[] = [];
    const config = { ...adapterConfig, timeoutMs: 5 };
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal instanceof AbortSignal) {
            signals.push(signal);
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }
        }),
    );
    const adapter = new TestOAuthAdapter(config);

    await expect(adapter.get('/accounts')).rejects.toBeDefined();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('aborts fetch signals when bank API requests time out', async () => {
    const signals: AbortSignal[] = [];
    const config = { ...adapterConfig, timeoutMs: 5 };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return tokenPayload('api-timeout-token');
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal instanceof AbortSignal) {
            signals.push(signal);
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }
        });
      },
    );
    const adapter = new TestOAuthAdapter(config);

    await expect(adapter.get('/accounts')).rejects.toBeDefined();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(signals.length + 1);
  });

  it('fails closed without live credentials and reports the active mode', async () => {
    expect(() =>
      parseEnv(
        makeEnv({
          ENABLE_MOCK_BANKS: 'false',
          BANK_GARANTI_CLIENT_ID: '',
          BANK_GARANTI_CLIENT_SECRET: '',
        }),
      ),
    ).toThrow(ConfigurationError);

    expect(
      () =>
        new GarantiBankAdapter(
          {
            ...adapterConfig,
            clientId: '',
            clientSecret: '',
            enableMockMode: false,
          },
          new Logger('error'),
        ),
    ).toThrow(ConfigurationError);

    const adapter = new GarantiBankAdapter(
      { ...adapterConfig, enableMockMode: true },
      new Logger('error'),
    );
    await expect(adapter.checkHealth()).resolves.toMatchObject({
      status: 'HEALTHY',
      mode: 'mock',
    });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenPayload('health-token'))
      .mockResolvedValueOnce(jsonResponse([]));
    const liveAdapter = new GarantiBankAdapter(
      { ...adapterConfig, enableMockMode: false },
      new Logger('error'),
    );
    await expect(liveAdapter.checkHealth()).resolves.toMatchObject({
      status: 'HEALTHY',
      mode: 'live',
    });
  });

  it('requires HTTPS URLs and omits an empty scope from the token form', async () => {
    expect(() =>
      parseEnv(
        makeEnv({
          BANK_GARANTI_TOKEN_URL: 'http://apis.garantibbva.com.tr/token',
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseEnv(
        makeEnv({
          BANK_GARANTI_BASE_URL: 'http://apis.garantibbva.com.tr',
        }),
      ),
    ).toThrow(ConfigurationError);

    let tokenForm: URLSearchParams | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          tokenForm = new URLSearchParams(String(init.body));
          return tokenPayload('scope-test-token');
        }
        return jsonResponse([]);
      },
    );
    const adapter = new TestOAuthAdapter({
      ...adapterConfig,
      scope: '   ',
    });

    await expect(adapter.get('/accounts')).resolves.toEqual([]);
    expect(tokenForm?.has('scope')).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(parseEnv(makeEnv()).BANK_GARANTI_SCOPE).toBe('');
  });
});
