import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { MarkdownRenderer } from '@/ui/components/shared';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/ui/components/ui/drawer';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Separator } from '@/ui/components/ui/separator';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { fetchSkill, type Skill, type SkillStatus } from '@/ui/lib/skills';
import { cn } from '@/ui/lib/utils';
import { CategoryBadge } from './CategoryBadge';

export interface SkillDetailDrawerProps {
  skillId: string | null;
  onClose: () => void;
}

const STATUS_BADGE: Record<SkillStatus, { label: string; className: string }> = {
  available: {
    label: 'Available',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  outdated: {
    label: 'Outdated',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  sync_error: {
    label: 'Sync Error',
    className: 'border-red-200 bg-red-50 text-red-800',
  },
};

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'N/A';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MetadataField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function renderResources(skill: Skill): React.ReactNode {
  if (skill.resources.length === 0) {
    return <p className="text-sm text-muted-foreground">No resources declared.</p>;
  }

  return (
    <ul className="space-y-2">
      {skill.resources.map((resource) => (
        <li key={resource} className="rounded border bg-muted/40 px-3 py-2">
          <code className="text-xs">{resource}</code>
        </li>
      ))}
    </ul>
  );
}

export function SkillDetailDrawer({ skillId, onClose }: SkillDetailDrawerProps) {
  const {
    data: skill,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['skill', skillId],
    queryFn: () => fetchSkill(skillId as string),
    enabled: Boolean(skillId),
  });

  const statusBadge = useMemo(() => (skill ? STATUS_BADGE[skill.status] : null), [skill]);

  return (
    <Drawer open={Boolean(skillId)} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="max-h-[94vh]" aria-describedby="skill-detail-description">
        <DrawerHeader className="pb-2">
          <DrawerTitle>{skill?.displayName ?? 'Skill Details'}</DrawerTitle>
          <DrawerDescription id="skill-detail-description">
            {skill?.slug ?? 'Review metadata and full SKILL.md instructions.'}
          </DrawerDescription>
        </DrawerHeader>

        {isLoading ? (
          <div className="space-y-4 px-4 pb-4">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-44 w-full" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 pb-4 text-center">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : 'Failed to load skill details'}
            </p>
          </div>
        ) : !skill ? (
          <div className="px-4 pb-4 text-sm text-muted-foreground">No skill selected.</div>
        ) : (
          <ScrollArea className="h-[72vh] px-4 pb-4">
            <div className="space-y-5">
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">{skill.displayName || skill.name}</h3>
                {skill.description && (
                  <p className="text-sm text-muted-foreground">{skill.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn(statusBadge?.className)}>
                    {statusBadge?.label ?? skill.status}
                  </Badge>
                  <CategoryBadge category={skill.category} />
                  <Badge variant="outline">{skill.source}</Badge>
                </div>
              </div>

              <Separator />

              <section className="grid gap-4 sm:grid-cols-2">
                <MetadataField label="Source" value={skill.source} />
                <MetadataField
                  label="Source URL"
                  value={
                    skill.sourceUrl ? (
                      <a
                        href={skill.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline"
                      >
                        Open source
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">Not available</span>
                    )
                  }
                />
                <MetadataField
                  label="License"
                  value={
                    skill.license ?? <span className="text-muted-foreground">Not specified</span>
                  }
                />
                <MetadataField
                  label="Compatibility"
                  value={
                    skill.compatibility ?? (
                      <span className="text-muted-foreground">Not specified</span>
                    )
                  }
                />
                <MetadataField label="Last Synced" value={formatDateTime(skill.lastSyncedAt)} />
                <MetadataField label="Updated" value={formatDateTime(skill.updatedAt)} />
              </section>

              <Separator />

              <section className="space-y-2">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Resources
                </h4>
                {renderResources(skill)}
              </section>

              <Separator />

              <section className="space-y-3">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Instruction Content
                </h4>
                {skill.instructionContent ? (
                  <div className="rounded-md border bg-background p-4">
                    <MarkdownRenderer content={skill.instructionContent} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No instruction content available.</p>
                )}
              </section>
            </div>
          </ScrollArea>
        )}

        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
