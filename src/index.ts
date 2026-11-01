import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnvConfig } from './config/env.schema.js';
import { BankAdapterRegistry } from './application/bank-adapter.factory.js';
import { DomainError } from './domain/errors.js';
import { registerGarantiAdapter } from './infrastructure/adapters/garanti.adapter.js';
import { Logger } from './infrastructure/observability/logger.js';
import { registerBankingTools } from './presentation/mcp/tool-registry.js';

async function startServer(): Promise<void> {
  let logger = new Logger();
  let server: Server | undefined;

  try {
    const config = loadEnvConfig();
    logger = new Logger(config.LOG_LEVEL);

    registerGarantiAdapter(
      {
        clientId: config.BANK_GARANTI_CLIENT_ID,
        clientSecret: config.BANK_GARANTI_CLIENT_SECRET,
        baseUrl: config.BANK_GARANTI_BASE_URL,
        tokenUrl: config.BANK_GARANTI_TOKEN_URL,
        timeoutMs: config.API_REQUEST_TIMEOUT_MS,
        failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        resetTimeoutMs: config.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
        enableMockMode: config.ENABLE_MOCK_BANKS,
      },
      logger,
    );

    const adapter = BankAdapterRegistry.resolve(config.ACTIVE_BANK_PROVIDER);
    server = new Server(
      { name: 'turkish-bank-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.onerror = () => {
      logger.error('MCP server encountered a runtime error.');
    };

    registerBankingTools(server, adapter, logger);

    const transport = new StdioServerTransport();
    transport.onerror = () => {
      logger.error('MCP stdio transport encountered a runtime error.');
    };
    await server.connect(transport);
    logger.info('Turkish Banking MCP server started.', {
      providerId: adapter.providerId,
    });

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
      if (shutdownPromise !== undefined) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        logger.info('Shutting down MCP server.', { signal });
        try {
          await server?.close();
        } catch {
          logger.error('MCP server shutdown failed.');
          process.exitCode = 1;
        }
      })();
      return shutdownPromise;
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (error: unknown) {
    const safeError =
      error instanceof DomainError
        ? error.toSafeJSON()
        : { name: 'StartupError', message: 'Application startup failed.' };
    logger.error('Application startup failed.', { error: safeError });

    if (server !== undefined) {
      try {
        await server.close();
      } catch {
        logger.error('MCP server cleanup after startup failure failed.');
      }
    }

    process.exitCode = 1;
  }
}

void startServer();
