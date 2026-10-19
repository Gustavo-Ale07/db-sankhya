import { createRedactor, REDACTED } from '@dbx/shared';
import type { FastifyServerOptions } from 'fastify';

/** Paths pino censors structurally; values are also scrubbed by content via the redactor. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.app_key',
  '*.app_secret',
  '*.appKey',
  '*.appSecret',
  '*.api_key',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.client_secret',
  '*.clientSecret',
  '*.access_token',
  '*.refresh_token',
  '*["x-token"]',
];

export function loggerOptions(
  level: string,
  secrets: readonly string[],
): FastifyServerOptions['logger'] {
  const scrub = createRedactor(secrets);
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    formatters: {
      // Last line of defence: scrub known secret values anywhere in the log object.
      // req/res are left to their (allowlisting) serializers instead of being deep-copied.
      log: (obj) => {
        const { req, res, ...rest } = obj;
        return {
          ...(scrub(rest) as Record<string, unknown>),
          ...(req !== undefined ? { req } : {}),
          ...(res !== undefined ? { res } : {}),
        };
      },
    },
    serializers: {
      req: (req: { method?: string; url?: string; id?: string; ip?: string }) => {
        const url = scrub(String(req.url ?? '')) as string;
        return {
          id: req.id,
          method: req.method,
          url: url.length > 300 ? `${url.slice(0, 300)}…` : url,
          ip: req.ip,
        };
      },
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}
