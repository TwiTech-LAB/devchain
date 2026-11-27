import { useId, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';
import { eqName } from './agentPlan';

// The dialog body is at most 60dvh high (ProjectSetupWizard). The roster takes its size from that
// limit, so the page itself does not scroll on a wide window: 60dvh less 6rem leaves room for the
// section title and the summary lines. The limit applies only while the columns are side by side;
// stacked columns scroll with the page.
export const ROSTER_SCROLL_CLASS = 'md:max-h-[calc(60dvh-6rem)] md:overflow-y-auto';

/**
 * One block of the roster: a team, or the agents in no team. The name and its note sit in a
 * tinted header band; the rows follow on the card surface. The band and the surface make each
 * block read as one unit.
 */
export function RosterGroup({
  title,
  badge,
  description,
  note,
  children,
}: {
  title: string;
  badge?: ReactNode;
  description?: ReactNode;
  /** A remark about the block, on its own line under the description. */
  note?: ReactNode;
  /** The rows. With no rows the block is the header band only. */
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-lg border bg-card">
      <div className="space-y-0.5 bg-muted px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h4 id={headingId} className="min-w-0 break-words text-sm font-semibold text-foreground">
            {title}
          </h4>
          {badge}
        </div>
        {description && <p className="break-words text-xs text-muted-foreground">{description}</p>}
        {note && <p className="break-words text-xs text-muted-foreground">{note}</p>}
      </div>
      {/* The rows start to the right of the team name, so they read as members of the block. */}
      {children ? <div className="border-t pl-12 pr-3">{children}</div> : null}
    </section>
  );
}

/**
 * `lead` marks the team lead. `member` indents the row under the lead; give it only when the
 * same block shows a lead row.
 */
export type RosterRole = 'lead' | 'member';

/**
 * The role of the row `name` in a block whose lead row is `lead`: `lead` for that row, `member`
 * for the others, and none when the block shows no lead row (`lead` is null).
 */
export function rosterRole(lead: string | null, name: string): RosterRole | undefined {
  if (lead === null) return undefined;
  if (eqName(lead, name)) return 'lead';
  return 'member';
}

/**
 * One roster row: name, badges, description and an alert on the left, the row's control
 * (`children`) on the right. On a narrow row the control moves to a second line.
 */
export function RosterRow({
  name,
  role,
  badge,
  description,
  alert,
  testId,
  children,
}: {
  name: ReactNode;
  role?: RosterRole;
  badge?: ReactNode;
  description?: ReactNode;
  alert?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    // A margin, not a padding, so the list divider above a member row starts at its indent.
    <li
      className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 py-2', role === 'member' && 'ml-6')}
      data-testid={testId}
    >
      {/* The 10rem basis wraps the control to its own line before the text column gets narrow. */}
      <div className="min-w-0 grow basis-40 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-sm font-medium text-foreground">{name}</span>
          {role === 'lead' && (
            <Badge variant="outline" className="font-normal" data-testid="wizard-lead-badge">
              Lead
            </Badge>
          )}
          {badge}
        </div>
        {description && (
          <p className="min-w-0 break-words text-xs text-muted-foreground">{description}</p>
        )}
        {alert}
      </div>
      {children}
    </li>
  );
}
