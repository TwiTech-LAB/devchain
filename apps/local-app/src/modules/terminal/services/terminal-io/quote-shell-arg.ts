export function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
