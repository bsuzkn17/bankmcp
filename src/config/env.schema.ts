import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigurationError } from '../domain/errors.js';

const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
    ACTIVE_BANK_PROVIDER: z.string().min(1),
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: positiveInteger,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: positiveInteger,
    API_REQUEST_TIMEOUT_MS: positiveInteger,
    ENABLE_MOCK_BANKS: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    BANK_GARANTI_CLIENT_ID: z.string().default(''),
    BANK_GARANTI_CLIENT_SECRET: z.string().default(''),
    BANK_GARANTI_BASE_URL: z.string().url(),
    BANK_GARANTI_TOKEN_URL: z.string().url(),
  })
  .strict();

export type EnvConfig = z.infer<typeof envSchema>;

function resolveSecretsFromFiles(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };

  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith('_SECRET')) {
      continue;
    }

    const inlineSecret = value?.trim() ?? '';
    if (inlineSecret.length > 0) {
      continue;
    }

    const secretFilePath = env[`${key}_FILE`]?.trim() ?? '';
    if (secretFilePath.length === 0) {
      continue;
    }

    try {
      resolved[key] = readFileSync(secretFilePath, 'utf8').trim();
    } catch {
      throw new ConfigurationError(
        undefined,
        'The configured secret file could not be read.',
      );
    }
  }

  return resolved;
}

export function loadEnvConfig(): EnvConfig {
  dotenv.config();

  const env = resolveSecretsFromFiles(process.env);

  const result = envSchema.safeParse({
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    ACTIVE_BANK_PROVIDER: env.ACTIVE_BANK_PROVIDER,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD:
      env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    API_REQUEST_TIMEOUT_MS: env.API_REQUEST_TIMEOUT_MS,
    ENABLE_MOCK_BANKS: env.ENABLE_MOCK_BANKS,
    BANK_GARANTI_CLIENT_ID: env.BANK_GARANTI_CLIENT_ID,
    BANK_GARANTI_CLIENT_SECRET: env.BANK_GARANTI_CLIENT_SECRET,
    BANK_GARANTI_BASE_URL: env.BANK_GARANTI_BASE_URL,
    BANK_GARANTI_TOKEN_URL: env.BANK_GARANTI_TOKEN_URL,
  });

  if (!result.success) {
    throw new ConfigurationError();
  }

  return result.data;
}
