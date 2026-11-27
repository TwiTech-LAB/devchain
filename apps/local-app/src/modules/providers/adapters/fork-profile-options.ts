interface PositionalPromptOptions {
  valueFlags: readonly string[];
  optionalValueFlags?: readonly string[];
  variadicFlags?: readonly string[];
  variadicPromptFlags?: readonly string[];
}

interface ShortFlagTable {
  boolean: readonly string[];
  takesValue: readonly string[];
}

function isValue(arg: string | undefined): boolean {
  return arg !== undefined && (arg === '-' || !arg.startsWith('-'));
}

/** Keep option values while dropping positional prompts in either CLI spelling. */
export function stripPositionalPrompt(
  args: readonly string[],
  {
    valueFlags,
    optionalValueFlags = [],
    variadicFlags = [],
    variadicPromptFlags = [],
  }: PositionalPromptOptions,
): string[] {
  const options: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (isValue(arg)) continue;

    const flag = arg.startsWith('--') ? arg.split('=', 1)[0] : arg.slice(0, 2);
    const isPromptFlag = variadicPromptFlags.includes(flag);
    if (!isPromptFlag) options.push(arg);

    if (isPromptFlag || variadicFlags.includes(flag)) {
      while (isValue(args[i + 1])) {
        i += 1;
        if (!isPromptFlag) options.push(args[i]);
      }
    } else if (
      arg === flag &&
      args[i + 1] !== undefined &&
      args[i + 1] !== '--' &&
      (valueFlags.includes(flag) || (optionalValueFlags.includes(flag) && isValue(args[i + 1])))
    ) {
      options.push(args[++i]);
    }
  }
  return options;
}

function findShortValueFlag(arg: string, table: ShortFlagTable): number {
  for (let index = 1; index < arg.length; index += 1) {
    const letter = arg[index];
    if (table.takesValue.includes(letter)) return index;
    if (!table.boolean.includes(letter)) break;
  }
  return -1;
}

export function stripPromptFlags(
  args: readonly string[],
  {
    valueFlags,
    optionalValueFlags = [],
    shortFlags,
  }: {
    valueFlags: readonly string[];
    optionalValueFlags?: readonly string[];
    shortFlags?: ShortFlagTable;
  },
): string[] {
  const options: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return [...options, ...args.slice(i)];

    const shortIndex =
      shortFlags && arg.startsWith('-') && !arg.startsWith('--')
        ? findShortValueFlag(arg, shortFlags)
        : -1;
    const flag = shortIndex === -1 ? arg.split('=', 1)[0] : `-${arg[shortIndex]}`;
    const required = valueFlags.includes(flag);
    const optional = optionalValueFlags.includes(flag);
    if (!required && !optional) {
      options.push(arg);
      continue;
    }

    if (shortIndex > 1) options.push(arg.slice(0, shortIndex));
    const valueStart = shortIndex === -1 ? flag.length : shortIndex + 1;
    if (
      valueStart === arg.length &&
      args[i + 1] !== undefined &&
      args[i + 1] !== '--' &&
      (required || isValue(args[i + 1]))
    ) {
      i += 1;
    }
  }
  return options;
}
