import { useMemo } from 'react';
import { Users } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';

const MAX_CONTRIBUTORS = 10;

export interface TopContributorsCardProps {
  snapshot: CodebaseOverviewSnapshot;
}

export function TopContributorsCard({ snapshot }: TopContributorsCardProps) {
  const contributors = useMemo(
    () =>
      [...snapshot.globalContributors]
        .sort(
          (a, b) =>
            b.commitCount30d - a.commitCount30d ||
            b.commitCount7d - a.commitCount7d ||
            a.authorName.localeCompare(b.authorName),
        )
        .slice(0, MAX_CONTRIBUTORS),
    [snapshot.globalContributors],
  );

  if (contributors.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">Top Contributors</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          <div className="mb-2 flex items-center px-2 text-xs font-medium text-muted-foreground">
            <span className="min-w-0 flex-1">Author</span>
            <span className="w-14 text-right">7d</span>
            <span className="w-14 text-right">30d</span>
          </div>
          {contributors.map((c) => (
            <div key={c.authorName} className="flex items-center rounded-md px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{c.authorName}</span>
              <span className="w-14 text-right text-xs text-muted-foreground">
                {c.commitCount7d}
              </span>
              <span className="w-14 text-right text-xs font-medium">{c.commitCount30d}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
