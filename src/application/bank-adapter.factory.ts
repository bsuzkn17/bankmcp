import type { IBankAdapter } from './bank-adapter.port.js';
import { ConfigurationError } from '../domain/errors.js';

export type BankAdapterFactoryFn = () => IBankAdapter;

export class BankAdapterRegistry {
  private static readonly factories = new Map<string, BankAdapterFactoryFn>();

  public static register(
    providerId: string,
    factory: BankAdapterFactoryFn,
  ): void {
    const normalizedProviderId = providerId.trim().toLowerCase();
    if (normalizedProviderId.length === 0) {
      throw new ConfigurationError();
    }

    this.factories.set(normalizedProviderId, factory);
  }

  public static resolve(providerId: string): IBankAdapter {
    const normalizedProviderId = providerId.trim().toLowerCase();
    const factory = this.factories.get(normalizedProviderId);

    if (factory === undefined) {
      const providers = this.listRegisteredProviders();
      const error = new ConfigurationError();
      error.message =
        providers.length === 0
          ? 'No bank adapter is registered.'
          : `Unknown bank provider. Registered providers: ${providers.join(', ')}.`;
      throw error;
    }

    return factory();
  }

  public static has(providerId: string): boolean {
    const normalizedProviderId = providerId.trim().toLowerCase();
    return normalizedProviderId.length > 0 &&
      this.factories.has(normalizedProviderId);
  }

  public static listRegisteredProviders(): readonly string[] {
    return [...this.factories.keys()];
  }

  public static clear(): void {
    this.factories.clear();
  }
}
