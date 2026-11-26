import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigurationError } from '../domain/errors.js';

const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number);

const GARANTI_TOKEN_URL =
  'https://apis.garantibbva.com.tr/auth/oauth/v2/token';

const optionalUrl = z.preprocess((value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().url().optional());

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
    BANK_GARANTI_TOKEN_URL: z.string().url().default(GARANTI_TOKEN_URL),
    BANK_GARANTI_REDIRECT_URI: optionalUrl,
  })
  .strict();

export type EnvConfig = z.infer<typeof envSchema>;

const SECRET_ENV_KEYS = ['BANK_GARANTI_CLIENT_SECRET'] as const;

function resolveSecretsFromFiles(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };
  const secretKeys = new Set<string>(SECRET_ENV_KEYS);

  for (const key of Object.keys(env)) {
    if (key.endsWith('_SECRET')) {
      secretKeys.add(key);
    } else if (key.endsWith('_SECRET_FILE')) {
      secretKeys.add(key.slice(0, -'_FILE'.length));
    }
  }

  for (const key of secretKeys) {
    const value = env[key];
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

export function parseEnv(env: NodeJS.ProcessEnv): EnvConfig {
  const resolvedEnv = resolveSecretsFromFiles(env);
  const result = envSchema.safeParse({
    NODE_ENV: resolvedEnv.NODE_ENV,
    LOG_LEVEL: resolvedEnv.LOG_LEVEL,
    ACTIVE_BANK_PROVIDER: resolvedEnv.ACTIVE_BANK_PROVIDER,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD:
      resolvedEnv.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS:
      resolvedEnv.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    API_REQUEST_TIMEOUT_MS: resolvedEnv.API_REQUEST_TIMEOUT_MS,
    ENABLE_MOCK_BANKS: resolvedEnv.ENABLE_MOCK_BANKS,
    BANK_GARANTI_CLIENT_ID: resolvedEnv.BANK_GARANTI_CLIENT_ID,
    BANK_GARANTI_CLIENT_SECRET: resolvedEnv.BANK_GARANTI_CLIENT_SECRET,
    BANK_GARANTI_BASE_URL: resolvedEnv.BANK_GARANTI_BASE_URL,
    BANK_GARANTI_TOKEN_URL: resolvedEnv.BANK_GARANTI_TOKEN_URL,
    BANK_GARANTI_REDIRECT_URI: resolvedEnv.BANK_GARANTI_REDIRECT_URI,
  });

  if (!result.success) {
    const invalidKey = result.error.issues[0]?.path[0];
    throw new ConfigurationError(
      undefined,
      `Invalid environment variable: ${
        typeof invalidKey === 'string' ? invalidKey : 'configuration'
      }.`,
    );
  }

  return result.data;
}

export function loadEnvConfig(): EnvConfig {
  dotenv.config();
  return parseEnv(process.env);
}
