import { useMemo, useState } from 'react';
import { Users, ChevronRight, HelpCircle } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/ui/components/ui/collapsible';
import { cn } from '@/ui/lib/utils';

const TOP_AUTHORS = 10;
const MAX_DISTRICTS_PER_AUTHOR = 10;

export interface TopContributorsByDistrictCardProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
}

interface AuthorDistrict {
  districtId: string;
  districtName: string;
  commitCount: number;
}

interface AuthorEntry {
  authorName: string;
  commitCount30d: number;
  districts: AuthorDistrict[];
}

export function TopContributorsByDistrictCard({
  snapshot,
  onSelectDistrict,
}: TopContributorsByDistrictCardProps) {
  const [openAuthors, setOpenAuthors] = useState<Set<string>>(new Set());

  const authors = useMemo((): AuthorEntry[] => {
    if (snapshot.globalContributors.length === 0) return [];

    const districtNameMap = new Map(snapshot.districts.map((d) => [d.id, d.name]));

    const topAuthors = [...snapshot.globalContributors]
      .sort((a, b) => b.commitCount30d - a.commitCount30d)
      .slice(0, TOP_AUTHORS);

    return topAuthors.map((gc) => {
      const districts: AuthorDistrict[] = [];
      for (const act of snapshot.activity) {
        if (act.targetKind !== 'district') continue;
        const contrib = act.recentContributors30d.find((c) => c.authorName === gc.authorName);
        if (!contrib) continue;
        const name = districtNameMap.get(act.targetId);
        if (!name) continue;
        districts.push({
          districtId: act.targetId,
          districtName: name,
          commitCount: contrib.commitCount,
        });
      }
      districts.sort((a, b) => b.commitCount - a.commitCount);
      return {
        authorName: gc.authorName,
        commitCount30d: gc.commitCount30d,
        districts: districts.slice(0, MAX_DISTRICTS_PER_AUTHOR),
      };
    });
  }, [snapshot]);

  if (authors.length === 0) return null;

  function toggleAuthor(name: string) {
    setOpenAuthors((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Top Contributors</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {authors.length}
              </Badge>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center h-10 w-10 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="About Top Contributors"
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p>
                  Top 10 authors by 30-day commit count. Expand to see which districts each author
                  contributes to.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {authors.map((author) => {
              const isOpen = openAuthors.has(author.authorName);
              return (
                <Collapsible
                  key={author.authorName}
                  open={isOpen}
                  onOpenChange={() => toggleAuthor(author.authorName)}
                >
                  <CollapsibleTrigger className="flex w-full min-h-10 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{author.authorName}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {author.commitCount30d} commits in 30d
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-6 border-l pl-3 py-1 space-y-0.5">
                      {author.districts.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-1">
                          No district-level data available
                        </p>
                      ) : (
                        author.districts.map((d) => (
                          <button
                            key={d.districtId}
                            type="button"
                            onClick={() => onSelectDistrict(d.districtId)}
                            className="flex w-full min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="min-w-0 flex-1 truncate">{d.districtName}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {d.commitCount} commits
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
