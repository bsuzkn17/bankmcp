import { randomUUID } from 'node:crypto';
import { sanitizeData, sanitizeText } from '../security/sanitizer.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AuditEvent {
  toolName: string;
  providerId: string;
  correlationId: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'REJECTED';
  durationMs: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createCorrelationId(): string {
  return randomUUID();
}

export class Logger {
  public constructor(private readonly minimumLevel: LogLevel = 'info') {}

  public debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  public audit(event: AuditEvent): void {
    const sanitizedMetadata =
      event.metadata === undefined ? undefined : sanitizeData(event.metadata);

    this.write('info', 'Audit event', {
      toolName: event.toolName,
      providerId: event.providerId,
      correlationId: event.correlationId,
      outcome: event.outcome,
      durationMs: event.durationMs,
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      ...(sanitizedMetadata === undefined
        ? {}
        : { metadata: sanitizedMetadata }),
    });
  }

  private write(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minimumLevel]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizeText(message),
      ...(context === undefined ? {} : { context: sanitizeData(context) }),
    };

    const jsonLine = JSON.stringify(entry);
    process.stderr.write(`${jsonLine}\n`);
  }
}
