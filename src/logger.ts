/* eslint-disable no-console */
/**
 * Structured JSON logs on stdout (002 §1). Never log a password, a connection URI or a raw
 * backend payload: `error` fields carry classified phrases only.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly request_id?: string;
  readonly operation_id?: string;
  readonly project_id?: string;
  readonly branch_id?: string;
  readonly endpoint_id?: string;
  readonly [key: string]: unknown;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(minLevel: LogLevel = 'info', base: LogFields = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...base, ...fields });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger(minLevel, { ...base, ...fields }),
  };
}

/** Silent logger for tests. */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
