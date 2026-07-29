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
 * Remove every occurrence of a flag and its value from an argv array, handling
 * BOTH the two-token `--flag value` form and the single-token `--flag=value`
 * form. Used by effort adapters to strip conflicting raw effort flags before
 * injecting their structured native form (so the UI's effort selection is
 * deterministic and never contradicted by leftover raw options).
 *
 * Not for `-c key=value` config flags whose VALUE carries the key (codex) —
 * that needs key-targeted matching and is handled inside the codex adapter.
 */
export function stripFlag(args: string[], flag: string): string[] {
  const result: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === flag) {
      // Two-token form: drop the flag and its following value token (if present).
      if (i + 1 < args.length) {
        i += 1;
      }
      continue;
    }

    if (arg.startsWith(`${flag}=`)) {
      // Single-token `--flag=value` form.
      continue;
    }

    result.push(arg);
  }

  return result;
}

/**
 * Detect any occurrence of a long-form flag without interpreting its value.
 * A bare trailing flag and an empty `--flag=` value both count: callers using
 * this as an ownership guard must defer to ambiguous user input.
 */
export function hasFlagOccurrence(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Extract the model value from an argv array.
 * Handles: --model X, -m X, --model=X, -m=X.
 * Returns the model string or null if no model flag is present.
 */
export function extractModelFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if ((arg === '--model' || arg === '-m') && i + 1 < args.length) {
      return args[i + 1];
    }

    if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      return arg.slice(arg.indexOf('=') + 1);
    }
  }

  return null;
}
