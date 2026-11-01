import type {
  BankAccount,
  BankTransaction,
  CurrencyCode,
  Money,
  TransactionFilter,
} from '../../domain/models.js';
import { BankAdapterError } from '../../domain/errors.js';
import { BankAdapterRegistry } from '../../application/bank-adapter.factory.js';
import { Logger } from '../observability/logger.js';
import { maskIban } from '../security/sanitizer.js';
import {
  OAuthBankAdapterBase,
  type OAuthAdapterConfig,
} from './oauth-bank-adapter.base.js';

interface GarantiRawAccount {
  accountId: string;
  iban: string;
  accountName: string;
  accountType: string;
  balance: number;
  currencyCode: CurrencyCode;
  isActive: boolean;
  updatedAt: string;
}

interface GarantiRawTransaction {
  transactionId: string;
  accountId: string;
  amount: number;
  currencyCode: CurrencyCode;
  direction: 'INBOUND' | 'OUTBOUND';
  description: string;
  category: string;
  transactionDate: string;
  referenceId: string;
}

interface GarantiRawBalance {
  amount: number;
  currencyCode: CurrencyCode;
}

const MOCK_ACCOUNTS: readonly GarantiRawAccount[] = [
  {
    accountId: 'garanti-try-demand-001',
    iban: 'TR120006200000000012345678',
    accountName: 'Günlük Hesabım',
    accountType: 'VADESIZ',
    balance: 42500.75,
    currencyCode: 'TRY',
    isActive: true,
    updatedAt: '2025-01-15T10:30:00.000Z',
  },
  {
    accountId: 'garanti-try-term-002',
    iban: 'TR340006200000000012345679',
    accountName: 'Birikim Vadeli',
    accountType: 'VADELI',
    balance: 125000,
    currencyCode: 'TRY',
    isActive: true,
    updatedAt: '2025-01-15T10:30:00.000Z',
  },
  {
    accountId: 'garanti-usd-term-003',
    iban: 'TR560006200000000012345680',
    accountName: 'USD Vadeli',
    accountType: 'VADELI',
    balance: 2750.5,
    currencyCode: 'USD',
    isActive: true,
    updatedAt: '2025-01-15T10:30:00.000Z',
  },
];

const MOCK_TRANSACTIONS: readonly GarantiRawTransaction[] = [
  {
    transactionId: 'mock-txn-try-001',
    accountId: 'garanti-try-demand-001',
    amount: 12500,
    currencyCode: 'TRY',
    direction: 'INBOUND',
    description: 'Maaş ödemesi',
    category: 'GELİR',
    transactionDate: '2025-01-10T09:00:00.000Z',
    referenceId: 'mock-ref-try-001',
  },
  {
    transactionId: 'mock-txn-try-002',
    accountId: 'garanti-try-demand-001',
    amount: 845.9,
    currencyCode: 'TRY',
    direction: 'OUTBOUND',
    description: 'Market alışverişi',
    category: 'ALIŞVERİŞ',
    transactionDate: '2025-01-12T14:20:00.000Z',
    referenceId: 'mock-ref-try-002',
  },
  {
    transactionId: 'mock-txn-term-001',
    accountId: 'garanti-try-term-002',
    amount: 1875,
    currencyCode: 'TRY',
    direction: 'INBOUND',
    description: 'Vadeli hesap faiz getirisi',
    category: 'FAİZ',
    transactionDate: '2025-01-15T08:00:00.000Z',
    referenceId: 'mock-ref-term-001',
  },
  {
    transactionId: 'mock-txn-usd-001',
    accountId: 'garanti-usd-term-003',
    amount: 42.5,
    currencyCode: 'USD',
    direction: 'INBOUND',
    description: 'Vadeli hesap faiz getirisi',
    category: 'FAİZ',
    transactionDate: '2025-01-15T08:00:00.000Z',
    referenceId: 'mock-ref-usd-001',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCurrencyCode(value: unknown): value is CurrencyCode {
  return value === 'TRY' || value === 'USD' || value === 'EUR' || value === 'GBP';
}

function isGarantiRawAccount(value: unknown): value is GarantiRawAccount {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.iban === 'string' &&
    typeof value.accountName === 'string' &&
    typeof value.accountType === 'string' &&
    typeof value.balance === 'number' &&
    Number.isFinite(value.balance) &&
    isCurrencyCode(value.currencyCode) &&
    typeof value.isActive === 'boolean' &&
    typeof value.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(value.updatedAt))
  );
}

function isGarantiRawTransaction(
  value: unknown,
): value is GarantiRawTransaction {
  return (
    isRecord(value) &&
    typeof value.transactionId === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    isCurrencyCode(value.currencyCode) &&
    (value.direction === 'INBOUND' || value.direction === 'OUTBOUND') &&
    typeof value.description === 'string' &&
    typeof value.category === 'string' &&
    typeof value.transactionDate === 'string' &&
    !Number.isNaN(Date.parse(value.transactionDate)) &&
    typeof value.referenceId === 'string'
  );
}

function isGarantiRawBalance(value: unknown): value is GarantiRawBalance {
  return (
    isRecord(value) &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    isCurrencyCode(value.currencyCode)
  );
}

export class GarantiBankAdapter extends OAuthBankAdapterBase {
  public constructor(
    config: OAuthAdapterConfig,
    logger: Logger = new Logger(),
  ) {
    super('garanti', 'Garanti BBVA', config, logger);
  }

  protected override async fetchAccountsFromApi(
    correlationId?: string,
  ): Promise<readonly BankAccount[]> {
    if (this.useMockMode) {
      return MOCK_ACCOUNTS.map((account) => this.normalizeAccount(account));
    }

    const response = await this.requestGet<unknown>('/accounts', undefined, correlationId);
    if (!Array.isArray(response) || !response.every(isGarantiRawAccount)) {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    return response.map((account) => this.normalizeAccount(account));
  }

  protected override async fetchAccountDetailsFromApi(
    accountId: string,
    correlationId?: string,
  ): Promise<BankAccount> {
    if (this.useMockMode) {
      const account = MOCK_ACCOUNTS.find((item) => item.accountId === accountId);
      if (account === undefined) {
        throw new BankAdapterError(this.providerId, correlationId);
      }
      return this.normalizeAccount(account);
    }

    const response = await this.requestGet<unknown>(
      `/accounts/${encodeURIComponent(accountId)}`,
      undefined,
      correlationId,
    );
    if (!isGarantiRawAccount(response)) {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    return this.normalizeAccount(response);
  }

  protected override async fetchAccountBalanceFromApi(
    accountId: string,
    correlationId?: string,
  ): Promise<Money> {
    if (this.useMockMode) {
      const account = MOCK_ACCOUNTS.find((item) => item.accountId === accountId);
      if (account === undefined) {
        throw new BankAdapterError(this.providerId, correlationId);
      }
      return {
        amount: account.balance,
        currency: account.currencyCode,
      };
    }

    const response = await this.requestGet<unknown>(
      `/accounts/${encodeURIComponent(accountId)}/balance`,
      undefined,
      correlationId,
    );
    if (!isGarantiRawBalance(response)) {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    return {
      amount: response.amount,
      currency: response.currencyCode,
    };
  }

  protected override async fetchTransactionsFromApi(
    filter: TransactionFilter,
    correlationId?: string,
  ): Promise<readonly BankTransaction[]> {
    if (this.useMockMode) {
      return this.filterTransactions(
        MOCK_TRANSACTIONS.map((transaction) =>
          this.normalizeTransaction(transaction),
        ),
        filter,
      );
    }

    const response = await this.requestGet<unknown>(
      `/accounts/${encodeURIComponent(filter.accountId)}/transactions`,
      {
        startDate: filter.startDate.toISOString(),
        endDate: filter.endDate.toISOString(),
        limit: filter.limit,
        offset: filter.offset,
      },
      correlationId,
    );
    if (!Array.isArray(response) || !response.every(isGarantiRawTransaction)) {
      throw new BankAdapterError(this.providerId, correlationId);
    }

    return response.map((transaction) =>
      this.normalizeTransaction(transaction),
    );
  }

  protected override async pingApi(correlationId?: string): Promise<void> {
    if (!this.useMockMode) {
      await this.requestGet<unknown>('/accounts', undefined, correlationId);
    }
  }

  private get useMockMode(): boolean {
    return (
      this.config.enableMockMode ||
      this.config.clientId.trim().length === 0 ||
      this.config.clientSecret.trim().length === 0
    );
  }

  private normalizeAccount(raw: GarantiRawAccount): BankAccount {
    return {
      id: raw.accountId,
      iban: raw.iban,
      maskedIban: maskIban(raw.iban),
      accountName: raw.accountName,
      accountType: raw.accountType,
      balance: {
        amount: raw.balance,
        currency: raw.currencyCode,
      },
      isActive: raw.isActive,
      updatedAt: new Date(raw.updatedAt),
    };
  }

  private normalizeTransaction(
    raw: GarantiRawTransaction,
  ): BankTransaction {
    return {
      id: raw.transactionId,
      accountId: raw.accountId,
      amount: {
        amount: raw.amount,
        currency: raw.currencyCode,
      },
      direction: raw.direction,
      description: raw.description,
      category: raw.category,
      transactionDate: new Date(raw.transactionDate),
      referenceId: raw.referenceId,
    };
  }

  private filterTransactions(
    transactions: readonly BankTransaction[],
    filter: TransactionFilter,
  ): readonly BankTransaction[] {
    return transactions
      .filter(
        (transaction) =>
          transaction.accountId === filter.accountId &&
          transaction.transactionDate >= filter.startDate &&
          transaction.transactionDate <= filter.endDate,
      )
      .slice(filter.offset, filter.offset + filter.limit);
  }
}

export function registerGarantiAdapter(
  config: OAuthAdapterConfig,
  logger?: Logger,
): void {
  BankAdapterRegistry.register(
    'garanti',
    () => new GarantiBankAdapter(config, logger),
  );
}
