import {
  ProviderAuthError,
  ProviderNotInstalledError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderPayloadError,
  ProviderModelNotFoundError,
} from './providers/types';

export interface ExplainedError {
  what: string;
  side: 'user-auth' | 'setup' | 'provider';
  nextStep: string;
}

export function explainProviderError(e: unknown): ExplainedError {
  if (e instanceof ProviderAuthError) {
    return {
      what: 'Authentication failed.',
      side: 'user-auth',
      nextStep: 'Check your API key in ~/.cc-habits/config.yml. For CLI providers, re-run `cch init --provider <name>`.',
    };
  }

  if (e instanceof ProviderNotInstalledError) {
    return {
      what: 'CLI command not found.',
      side: 'setup',
      nextStep: 'Verify the CLI tool (e.g. `claude` or `gemini`) is installed and available in your shell PATH.',
    };
  }

  if (e instanceof ProviderQuotaError) {
    return {
      what: 'Quota or credit balance exhausted.',
      side: 'provider',
      nextStep: 'Check your billing details or subscription status with your AI provider.',
    };
  }

  if (e instanceof ProviderModelNotFoundError) {
    return {
      what: `Model '${e.model}' is not available on this Ollama instance.`,
      side: 'setup',
      nextStep: `Run \`ollama pull ${e.model}\` to install it, or \`cch init --provider ollama\` to pick an installed model. Note tags must match exactly (e.g. \`llama3.2:1b\`, not \`llama3.2\`).`,
    };
  }

  if (e instanceof ProviderRateLimitError) {
    return {
      what: 'Rate limit exceeded.',
      side: 'provider',
      nextStep: 'Extraction skipped this session. Start a new session in a moment to retry.',
    };
  }

  if (e instanceof ProviderTimeoutError) {
    return {
      what: 'Request timed out.',
      side: 'provider',
      nextStep: 'Check your connection. Extraction will retry next session.',
    };
  }

  if (e instanceof ProviderPayloadError) {
    return {
      what: 'Batch exceeded the provider\'s per-request limit (often a free-tier tokens-per-minute cap).',
      side: 'setup',
      nextStep: 'Try `cch learn --since 2` for a smaller window, wait a minute and retry, or switch to a local Ollama model with `cch init --provider ollama`.',
    };
  }

  // Fallback for general errors
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.toLowerCase().includes('enoent')) {
    return {
      what: 'Command executable not found in PATH.',
      side: 'setup',
      nextStep: 'Ensure the selected CLI provider (e.g., claude or gemini) is installed and in your system PATH.',
    };
  }

  return {
    what: msg || 'An unknown provider error occurred.',
    side: 'provider',
    nextStep: 'Check `cch status` and your provider config.',
  };
}
