import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type {
  IBankAdapter,
  AdapterHealthStatus,
} from '../../application/bank-adapter.port.js';
import { DomainError } from '../../domain/errors.js';
import type { TransactionFilter } from '../../domain/models.js';
import {
  createCorrelationId,
  Logger,
} from '../../infrastructure/observability/logger.js';
import { sanitizeData } from '../../infrastructure/security/sanitizer.js';

const emptyInputSchema = z.object({}).strict();

const accountIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);

const isoDateSchema = z.string().datetime({ offset: true });

const accountIdInputSchema = z
  .object({
    accountId: accountIdSchema,
  })
  .strict();

const transactionsInputSchema = z
  .object({
    accountId: accountIdSchema,
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict()
  .refine(
    ({ startDate, endDate }) =>
      startDate === undefined ||
      endDate === undefined ||
      Date.parse(startDate) <= Date.parse(endDate),
    {
      path: ['endDate'],
      message: 'Date range is invalid.',
    },
  );

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'banking_check_health',
    description: 'Check the configured bank provider connection health.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'banking_list_accounts',
    description: 'List accounts available from the configured bank provider.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'banking_get_account_details',
    description: 'Get sanitized details for a single bank account.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          minLength: 2,
          maxLength: 64,
          pattern: '^[a-zA-Z0-9_-]+$',
        },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'banking_get_account_balance',
    description: 'Get the current balance of a bank account.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          minLength: 2,
          maxLength: 64,
          pattern: '^[a-zA-Z0-9_-]+$',
        },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'banking_get_transactions',
    description: 'List transactions for an account within an optional date range.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          minLength: 2,
          maxLength: 64,
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        startDate: { type: 'string', format: 'date-time' },
        endDate: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

type ToolOperation<TInput> = (
  input: TInput,
  correlationId: string,
) => Promise<unknown>;

function toToolResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function serializeSafeResult(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new Error('Unable to serialize tool result.');
  }
  return serialized;
}

export async function executeToolWithObservability<TInput>(
  toolName: string,
  rawInput: unknown,
  schema: z.ZodType<TInput>,
  adapter: IBankAdapter,
  logger: Logger,
  operation: ToolOperation<TInput>,
): Promise<CallToolResult> {
  const correlationId = createCorrelationId();
  const startedAt = Date.now();
  const parsedInput = schema.safeParse(rawInput);

  if (!parsedInput.success) {
    logger.audit({
      toolName,
      providerId: adapter.providerId,
      correlationId,
      outcome: 'REJECTED',
      durationMs: Date.now() - startedAt,
      errorCode: 'INVALID_INPUT',
    });
    return toToolResult(
      serializeSafeResult({
        error: {
          code: 'INVALID_INPUT',
          message: 'Tool input is invalid.',
        },
        correlationId,
      }),
      true,
    );
  }

  try {
    const result = await operation(parsedInput.data, correlationId);
    const safeResult = sanitizeData(result);
    const text = serializeSafeResult({
      correlationId,
      data: safeResult,
    });

    logger.audit({
      toolName,
      providerId: adapter.providerId,
      correlationId,
      outcome: 'SUCCESS',
      durationMs: Date.now() - startedAt,
    });

    return toToolResult(text);
  } catch (error: unknown) {
    const safeError =
      error instanceof DomainError
        ? error.toSafeJSON()
        : {
            name: 'InternalError',
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred.',
            correlationId,
          };
    const sanitizedError = sanitizeData(safeError);
    const errorCode =
      error instanceof DomainError ? error.code : 'INTERNAL_ERROR';

    logger.audit({
      toolName,
      providerId: adapter.providerId,
      correlationId,
      outcome: 'FAILURE',
      durationMs: Date.now() - startedAt,
      errorCode,
    });

    return toToolResult(
      serializeSafeResult({
        error: sanitizedError,
        correlationId,
      }),
      true,
    );
  }
}

export interface BankingToolHandlers {
  banking_check_health(input?: unknown): Promise<CallToolResult>;
  banking_list_accounts(input?: unknown): Promise<CallToolResult>;
  banking_get_account_details(input?: unknown): Promise<CallToolResult>;
  banking_get_account_balance(input?: unknown): Promise<CallToolResult>;
  banking_get_transactions(input?: unknown): Promise<CallToolResult>;
}

export function createToolHandlers(
  adapter: IBankAdapter,
  logger: Logger,
): BankingToolHandlers {
  return {
    banking_check_health: (input = {}) =>
      executeToolWithObservability(
        'banking_check_health',
        input,
        emptyInputSchema,
        adapter,
        logger,
        async (_parsedInput, correlationId): Promise<AdapterHealthStatus> =>
          adapter.checkHealth(correlationId),
      ),
    banking_list_accounts: (input = {}) =>
      executeToolWithObservability(
        'banking_list_accounts',
        input,
        emptyInputSchema,
        adapter,
        logger,
        (_parsedInput, correlationId) => adapter.listAccounts(correlationId),
      ),
    banking_get_account_details: (input = {}) =>
      executeToolWithObservability(
        'banking_get_account_details',
        input,
        accountIdInputSchema,
        adapter,
        logger,
        ({ accountId }, correlationId) =>
          adapter.getAccountDetails(accountId, correlationId),
      ),
    banking_get_account_balance: (input = {}) =>
      executeToolWithObservability(
        'banking_get_account_balance',
        input,
        accountIdInputSchema,
        adapter,
        logger,
        ({ accountId }, correlationId) =>
          adapter.getAccountBalance(accountId, correlationId),
      ),
    banking_get_transactions: (input = {}) =>
      executeToolWithObservability(
        'banking_get_transactions',
        input,
        transactionsInputSchema,
        adapter,
        logger,
        ({ accountId, startDate, endDate, limit, offset }, correlationId) => {
          const filter: TransactionFilter = {
            accountId,
            startDate:
              startDate === undefined ? new Date(0) : new Date(startDate),
            endDate: endDate === undefined ? new Date() : new Date(endDate),
            limit: limit ?? 20,
            offset: offset ?? 0,
          };
          return adapter.getTransactions(filter, correlationId);
        },
      ),
  };
}

export function registerBankingTools(
  server: Server,
  adapter: IBankAdapter,
  logger: Logger,
): void {
  const handlers = createToolHandlers(adapter, logger);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = args ?? {};

    switch (name) {
      case 'banking_check_health':
        return handlers.banking_check_health(input);
      case 'banking_list_accounts':
        return handlers.banking_list_accounts(input);
      case 'banking_get_account_details':
        return handlers.banking_get_account_details(input);
      case 'banking_get_account_balance':
        return handlers.banking_get_account_balance(input);
      case 'banking_get_transactions':
        return handlers.banking_get_transactions(input);
      default: {
        const correlationId = createCorrelationId();
        logger.audit({
          toolName: 'unknown_tool',
          providerId: adapter.providerId,
          correlationId,
          outcome: 'REJECTED',
          durationMs: 0,
          errorCode: 'UNKNOWN_TOOL',
        });
        return toToolResult(
          serializeSafeResult({
            error: {
              code: 'UNKNOWN_TOOL',
              message: 'The requested tool is not available.',
            },
            correlationId,
          }),
          true,
        );
      }
    }
  });
}
