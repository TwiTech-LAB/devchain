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
