// Provider contract and error types. Kept dependency-free so concrete
// providers can import it without creating an import cycle through index.ts.

export interface Provider {
  name: string;
  generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string>;
}

export class ProviderRateLimitError extends Error {
  constructor(provider: string) {
    super(`${provider}: rate limited (HTTP 429). Skipping extraction this session.`);
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(provider: string, ms: number) {
    super(`${provider}: request timed out after ${ms}ms. Skipping extraction.`);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderPayloadError extends Error {
  constructor(provider: string) {
    super(`${provider}: request payload too large (HTTP 413). Batch was trimmed but still exceeded the limit.`);
    this.name = 'ProviderPayloadError';
  }
}

export class ProviderAuthError extends Error {
  readonly side = 'user-auth' as const;
  constructor(provider: string, message?: string) {
    super(message || `${provider}: authentication failed (check API key or CLI login).`);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderNotInstalledError extends Error {
  readonly side = 'setup' as const;
  constructor(provider: string, message?: string) {
    super(message || `${provider}: executable not found in PATH.`);
    this.name = 'ProviderNotInstalledError';
  }
}

export class ProviderQuotaError extends Error {
  readonly side = 'provider' as const;
  constructor(provider: string, message?: string) {
    super(message || `${provider}: quota/credit balance exhausted.`);
    this.name = 'ProviderQuotaError';
  }
}

