import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.schema.js';
import { ConfigurationError } from '../src/domain/errors.js';

function readEnvExample(): Record<string, string> {
  return dotenv.parse(readFileSync(join(process.cwd(), '.env.example'), 'utf8'));
}

describe('.env.example configuration', () => {
  it('parses the checked-in environment template', () => {
    const config = parseEnv(readEnvExample());

    expect(config.ACTIVE_BANK_PROVIDER).toBe('garanti');
    expect(config.ENABLE_MOCK_BANKS).toBe(true);
  });

  it('loads a secret file when the inline secret key is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'turkish-bank-mcp-'));
    const secretFilePath = join(directory, 'client_secret');

    try {
      writeFileSync(secretFilePath, 'file-sourced-secret\n', 'utf8');
      const env = readEnvExample();
      delete env.BANK_GARANTI_CLIENT_SECRET;
      env.BANK_GARANTI_CLIENT_SECRET_FILE = secretFilePath;

      expect(parseEnv(env).BANK_GARANTI_CLIENT_SECRET).toBe(
        'file-sourced-secret',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('identifies an invalid environment key without exposing its value', () => {
    const env = readEnvExample();
    env.LOG_LEVEL = 'secret-invalid-value';

    try {
      parseEnv(env);
      throw new Error('Expected parseEnv to reject an invalid LOG_LEVEL.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      if (error instanceof ConfigurationError) {
        expect(error.message).toContain('LOG_LEVEL');
        expect(error.message).not.toContain('secret-invalid-value');
      }
    }
  });
});
