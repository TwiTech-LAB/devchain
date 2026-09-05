import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import type {
  EpicRelationDirectionDraft,
  RelatedRouteIneligibilityCause,
} from '@/ui/lib/epic-relations';

export interface EpicRelationEndpoint {
  id: string;
  title: string;
  subtitle?: string;
}

interface EpicRelationDirectionPickerProps {
  /** The initiated Epic — the linkage's default source. */
  source: EpicRelationEndpoint;
  /** The selected Epic — the linkage's default target. */
  target: EpicRelationEndpoint;
  value: EpicRelationDirectionDraft;
  onChange(next: EpicRelationDirectionDraft): void;
  /**
   * Whether a Related link between these endpoints routes time: both roots in
   * one project. Ineligible links stay valid but never affect Epic time.
   */
  eligible: boolean;
  /**
   * Why a Related link cannot route time; shown only while ineligible so the
   * copy names the actual cause instead of a generic refusal.
   */
  ineligibilityCause?: RelatedRouteIneligibilityCause;
  /** The stored pair carries no direction yet (legacy neutral row). */
  legacyNeutral?: boolean;
  /** External-link state of the two endpoints only; never per-candidate. */
  sourceLinked?: boolean;
  targetLinked?: boolean;
  disabled?: boolean;
}

function EndpointCard({
  endpoint,
  label,
  linked,
  logsTime,
}: {
  endpoint: EpicRelationEndpoint;
  label: string;
  linked: boolean;
  logsTime: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {logsTime ? (
            <Badge variant="secondary" aria-label="Logs time">
              Logs time
            </Badge>
          ) : null}
          {linked ? (
            <Badge variant="outline" aria-label="Linked to an external task">
              Linked
            </Badge>
          ) : null}
        </span>
      </div>
      <p className="mt-1 truncate text-sm font-medium" title={endpoint.title}>
        {endpoint.title}
      </p>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {endpoint.subtitle ? `${endpoint.subtitle} · ` : ''}
        <span className="font-mono">{endpoint.id.slice(0, 8)}</span>
      </p>
    </div>
  );
}

function DirectedArrow({ reversed }: { reversed: boolean }) {
  if (reversed) {
    return (
      <>
        <ArrowLeft className="hidden h-4 w-4 sm:block" aria-hidden="true" />
        <ArrowUp className="h-4 w-4 sm:hidden" aria-hidden="true" />
      </>
    );
  }

  return (
    <>
      <ArrowRight className="hidden h-4 w-4 sm:block" aria-hidden="true" />
      <ArrowDown className="h-4 w-4 sm:hidden" aria-hidden="true" />
    </>
  );
}

export function EpicRelationDirectionPicker({
  source,
  target,
  value,
  onChange,
  eligible,
  ineligibilityCause,
  legacyNeutral = false,
  sourceLinked = false,
  targetLinked = false,
  disabled = false,
}: EpicRelationDirectionPickerProps) {
  // The draft source decides which way the one arrow points; Related and
  // Blocks share the same arrow, and activating it swaps source and target.
  const draftSource = value.sourceIsFocal ? source : target;
  const draftTarget = value.sourceIsFocal ? target : source;

  let directionSummary: string;
  let visibleSummary: string;
  let connectorLabel: string;
  if (value.type === 'blocks') {
    directionSummary = `${draftSource.title} blocks ${draftTarget.title}`;
    visibleSummary = `“${draftSource.title}” blocks “${draftTarget.title}”.`;
    connectorLabel = 'blocks';
  } else if (eligible) {
    directionSummary = `${draftTarget.title} logs time with ${draftSource.title}`;
    visibleSummary = `“${draftTarget.title}” logs time with “${draftSource.title}”.`;
    connectorLabel = 'logs time';
  } else if (ineligibilityCause === 'cross-project') {
    directionSummary =
      'This Related link does not affect Epic time: only Epics in one project route time';
    visibleSummary = `${directionSummary}.`;
    connectorLabel = 'no time route';
  } else if (ineligibilityCause === 'child') {
    directionSummary = 'This Related link does not affect Epic time: child Epics never route time';
    visibleSummary = `${directionSummary}.`;
    connectorLabel = 'no time route';
  } else {
    directionSummary = 'This Related link does not affect Epic time';
    visibleSummary = `${directionSummary}.`;
    connectorLabel = 'no time route';
  }

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">Relation type</legend>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={value.type === 'related' ? 'default' : 'outline'}
            aria-pressed={value.type === 'related'}
            onClick={() => onChange({ ...value, type: 'related' })}
          >
            Related
          </Button>
          <Button
            type="button"
            variant={value.type === 'blocks' ? 'default' : 'outline'}
            aria-pressed={value.type === 'blocks'}
            onClick={() => onChange({ ...value, type: 'blocks' })}
          >
            Blocks
          </Button>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
        <EndpointCard
          endpoint={source}
          label={value.sourceIsFocal ? 'Source' : 'Target'}
          linked={sourceLinked}
          logsTime={value.type === 'related' && eligible && !value.sourceIsFocal}
        />

        <div className="flex flex-col items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="rounded-full"
            onClick={() => onChange({ ...value, sourceIsFocal: !value.sourceIsFocal })}
            disabled={disabled}
            aria-label={`Swap source and target. ${directionSummary}.`}
          >
            <DirectedArrow reversed={!value.sourceIsFocal} />
          </Button>
          <span className="text-xs font-medium text-muted-foreground">{connectorLabel}</span>
        </div>

        <EndpointCard
          endpoint={target}
          label={value.sourceIsFocal ? 'Target' : 'Source'}
          linked={targetLinked}
          logsTime={value.type === 'related' && eligible && value.sourceIsFocal}
        />
      </div>

      <p className="text-xs text-muted-foreground" data-testid="relation-direction-summary">
        {visibleSummary}
      </p>
      {legacyNeutral && value.type === 'related' ? (
        <p className="text-xs text-muted-foreground">
          This pair has no direction yet. Saving stores the direction shown above.
        </p>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {directionSummary}.
      </p>
    </div>
  );
}
