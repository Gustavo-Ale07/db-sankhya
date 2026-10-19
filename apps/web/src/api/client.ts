// Same-origin JSON client. Credentials travel only as the HttpOnly session cookie; the browser
// never sees ERP credentials. Every non-GET call sends JSON so the server's CSRF checks apply.

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

type Listener = (err: ApiError) => void;
const authListeners = new Set<Listener>();

/** Notified when the session is gone (401) or a password change is required (403). */
export function onAuthError(listener: Listener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

const AUTH_CODES = new Set(['AUTH_REQUIRED', 'SESSION_EXPIRED', 'PASSWORD_CHANGE_REQUIRED']);

export interface RequestOptions {
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined | null>;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  let url = path;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, { code: 'NETWORK_ERROR', message: 'Network error' });
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const errBody = (data as { error?: ApiErrorBody } | undefined)?.error ?? {
      code: res.status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR',
      message: `HTTP ${res.status}`,
    };
    const err = new ApiError(res.status, errBody);
    if (AUTH_CODES.has(err.code) && !path.startsWith('/api/auth/login')) {
      for (const l of authListeners) l(err);
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body: unknown = {}, opts?: RequestOptions) =>
    request<T>('POST', path, body, opts),
  put: <T>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>('PATCH', path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

export function newExecutionId(): string {
  return crypto.randomUUID();
}
