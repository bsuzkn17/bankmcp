import type {
  AdapterCapabilities,
  BankAccount,
  BankTransaction,
  Money,
  TransactionFilter,
} from '../domain/models.js';

export interface AdapterHealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';
  providerId: string;
  latencyMs: number;
  checkedAt: string;
  message?: string;
}

export interface IBankAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly capabilities: AdapterCapabilities;

  checkHealth(correlationId?: string): Promise<AdapterHealthStatus>;
  listAccounts(correlationId?: string): Promise<readonly BankAccount[]>;
  getAccountDetails(
    accountId: string,
    correlationId?: string,
  ): Promise<BankAccount>;
  getAccountBalance(
    accountId: string,
    correlationId?: string,
  ): Promise<Money>;
  getTransactions(
    filter: TransactionFilter,
    correlationId?: string,
  ): Promise<readonly BankTransaction[]>;
}
