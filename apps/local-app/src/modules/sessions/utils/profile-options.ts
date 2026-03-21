export class ProfileOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileOptionsError';
  }
}

export function parseProfileOptions(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  const finishToken = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (ch === '\n' || ch === '\r' || ch.charCodeAt(0) < 0x20) {
      throw new ProfileOptionsError('Options may not include control characters or newlines.');
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }

      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === quote || next === '\\') {
          current += next;
          i += 1;
          continue;
        }
      }

      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '"' || next === "'" || next === '\\' || next === ' ') {
        current += next;
        i += 1;
        continue;
      }
    }

    if (ch === ' ') {
      finishToken();
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new ProfileOptionsError('Options contain an unterminated quote.');
  }

  finishToken();
  return tokens;
}

/**
 * Inject model override into parsed argv, replacing any existing model flags.
 * Handles: --model X, -m X, --model=X, -m=X.
 */
export function injectModelOverride(args: string[], model: string): string[] {
  const cleanedArgs: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--model' || arg === '-m') {
      if (i + 1 < args.length) {
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      continue;
    }

    cleanedArgs.push(arg);
  }

  return ['--model', model, ...cleanedArgs];
}

/**
 * Rewrite the --model/-m value to the [1m] alias variant for 1M context.
 * Only opus family models are rewritten: "opus" → opus[1m]. Sonnet and unknown → unchanged.
 * When no model flag is present, defaults to --model opus[1m].
 * Handles: --model X, -m X, --model=X, -m=X.
 */
export function rewriteModelTo1m(args: string[]): string[] {
  const result: string[] = [];
  let foundModel = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--model' || arg === '-m') {
      foundModel = true;
      if (i + 1 < args.length) {
        result.push('--model', rewriteValue(args[i + 1]));
        i += 1;
      } else {
        result.push('--model', 'opus[1m]');
      }
      continue;
    }

    if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      foundModel = true;
      const value = arg.slice(arg.indexOf('=') + 1);
      result.push('--model', rewriteValue(value));
      continue;
    }

    result.push(arg);
  }

  if (!foundModel) {
    return ['--model', 'opus[1m]', ...result];
  }

  return result;
}

/**
 * Detect Claude model family from a model name string.
 * Returns 'opus' | 'sonnet' | null based on case-insensitive substring match.
 */
export function detectClaudeModelFamily(model: string): 'opus' | 'sonnet' | null {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) {
    return 'opus';
  }
  if (lower.includes('sonnet')) {
    return 'sonnet';
  }
  return null;
}

function rewriteValue(value: string): string {
  const family = detectClaudeModelFamily(value);
  if (family === 'opus') {
    return 'opus[1m]';
  }
  return value;
}
