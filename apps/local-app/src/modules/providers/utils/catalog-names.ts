/**
 * Catalog row names (models or efforts) grouped by provider id. Each provider keeps the row
 * order it had in `rows`; the storage batch reads return rows in catalog position order.
 */
export function groupNamesByProvider(
  rows: ReadonlyArray<{ providerId: string; name: string }>,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const names = grouped.get(row.providerId) ?? [];
    names.push(row.name);
    grouped.set(row.providerId, names);
  }
  return grouped;
}
