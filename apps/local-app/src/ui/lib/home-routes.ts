// Routes that manage the DevChain instance itself, not a specific project: they must
// keep working from the home client and socket no matter which backend the active
// project is bound to, or whether that backend is currently reachable.
//
// `/settings` is deliberately excluded: `GeneralSection` fetches
// `/api/prompts?projectId=<selectedProject.id>` and its save mutation carries the same
// `projectId` through the bound `useFetchFactory` fetch, so it still needs the active
// project's backend to be resolvable.
const HOME_ROUTE_PREFIXES = ['/cloud', '/projects'] as const;

export function isHomeRoute(pathname: string): boolean {
  return HOME_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
