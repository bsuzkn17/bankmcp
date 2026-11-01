export type CurrencyCode = 'TRY' | 'USD' | 'EUR' | 'GBP';

export interface Money {
  amount: number;
  currency: CurrencyCode;
}

export interface BankAccount {
  id: string;
  iban: string;
  maskedIban: string;
  accountName: string;
  accountType: string;
  balance: Money;
  isActive: boolean;
  updatedAt: Date;
}

export interface BankTransaction {
  id: string;
  accountId: string;
  amount: Money;
  direction: 'INBOUND' | 'OUTBOUND';
  description: string;
  category: string;
  transactionDate: Date;
  referenceId: string;
}

export interface TransactionFilter {
  accountId: string;
  startDate: Date;
  endDate: Date;
  limit: number;
  offset: number;
}

export interface AdapterCapabilities {
  supportsAccountListing: boolean;
  supportsBalanceQuery: boolean;
  supportsTransactionHistory: boolean;
  readonly supportsPayments: false;
  readonly supportsTransfers: false;
  readonly supportsCardManagement: false;
}
