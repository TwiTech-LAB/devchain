export function shortModelName(name: string): string {
  const lastSlash = name.lastIndexOf('/');
  return lastSlash >= 0 ? name.substring(lastSlash + 1) : name;
}
