import type { AnalysisWarning, AnalysisWarningCode } from '@devchain/codebase-overview';
import { HelpCircle } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

// ---------------------------------------------------------------------------
// Severity classification (UI-side mapping — not a backend field)
// ---------------------------------------------------------------------------

type WarningSeverity = 'informational' | 'degraded' | 'unavailable';

const WARNING_SEVERITY: Record<AnalysisWarningCode, WarningSeverity> = {
  partial_test_detection: 'informational',
  loc_unavailable: 'degraded',
  coverage_unmeasured: 'degraded',
  daily_churn_unavailable: 'degraded',
  windowed_authors_unavailable: 'degraded',
  shallow_git_history: 'unavailable',
  missing_dependency_data: 'unavailable',
  coupling_unavailable: 'unavailable',
};

// ---------------------------------------------------------------------------
// "Why?" explanation copy — keyed by code, never fetched from backend
// ---------------------------------------------------------------------------

const WARNING_EXPLANATION: Record<AnalysisWarningCode, string> = {
  partial_test_detection:
    'Test detection uses file-naming patterns and may miss test files that follow non-standard naming conventions.',
  loc_unavailable:
    'Lines of code could not be measured for all files. Files larger than 256 KB and binary files are excluded from LOC counting.',
  coverage_unmeasured:
    'Test coverage rate could not be computed. No supported language adapters detected colocated test pairs for source files in this codebase.',
  daily_churn_unavailable:
    'Daily churn metrics require more git history than this repository currently provides.',
  windowed_authors_unavailable:
    'Windowed author attribution requires additional git history that is not yet available.',
  shallow_git_history:
    'This repository was cloned with limited history (shallow clone). Churn, staleness, and ownership signals may be incomplete or inaccurate. Run `git fetch --unshallow` to restore full history.',
  missing_dependency_data:
    'Import graph data is unavailable. Coupling scores and blast-radius metrics cannot be computed without dependency information.',
  coupling_unavailable:
    'Coupling scores could not be computed because no import graph data is available for this codebase.',
};

// ---------------------------------------------------------------------------
// Severity visual config
// ---------------------------------------------------------------------------

interface SeverityConfig {
  label: string;
  alertClassName: string;
  badgeClassName: string;
}

const SEVERITY_CONFIG: Record<WarningSeverity, SeverityConfig> = {
  unavailable: {
    label: 'Unavailable',
    alertClassName: 'border-destructive/40 text-destructive dark:border-destructive/60',
    badgeClassName: 'border-destructive/60 text-destructive',
  },
  degraded: {
    label: 'Degraded data',
    alertClassName:
      'border-amber-400/50 text-amber-800 dark:border-amber-600/40 dark:text-amber-400',
    badgeClassName:
      'border-amber-500/60 text-amber-800 dark:border-amber-600/60 dark:text-amber-400',
  },
  informational: {
    label: 'Informational',
    alertClassName: '',
    badgeClassName: 'text-muted-foreground',
  },
};

const SEVERITY_ORDER: WarningSeverity[] = ['unavailable', 'degraded', 'informational'];

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatMessage(w: AnalysisWarning): string {
  if (w.code === 'loc_unavailable' && w.data) {
    const { counted, eligible, skipped } = w.data;
    if (counted !== undefined && eligible !== undefined && skipped !== undefined) {
      return `LOC counted for ${counted}/${eligible} files (${skipped} skipped: large or binary)`;
    }
  }
  return w.message;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface WarningsBarProps {
  warnings: AnalysisWarning[];
  excludedAuthorCount?: number;
  onNavigateToScope?: () => void;
}

export function WarningsBar({
  warnings,
  excludedAuthorCount,
  onNavigateToScope,
}: WarningsBarProps) {
  const hasExcludedAuthors = typeof excludedAuthorCount === 'number' && excludedAuthorCount > 0;
  if (warnings.length === 0 && !hasExcludedAuthors) return null;

  const grouped = new Map<WarningSeverity, AnalysisWarning[]>(SEVERITY_ORDER.map((s) => [s, []]));
  for (const w of warnings) {
    const severity = WARNING_SEVERITY[w.code] ?? 'informational';
    grouped.get(severity)!.push(w);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="warnings-bar">
      {hasExcludedAuthors && (
        <Alert
          className={SEVERITY_CONFIG.informational.alertClassName}
          data-testid="warnings-excluded-authors"
        >
          <AlertDescription>
            <div className="flex items-center gap-3">
              <Badge
                variant="outline"
                className={`shrink-0 text-[10px] px-1.5 py-0 ${SEVERITY_CONFIG.informational.badgeClassName}`}
              >
                {SEVERITY_CONFIG.informational.label}
              </Badge>
              <span className="flex-1 text-sm leading-snug">
                {excludedAuthorCount} contributor{excludedAuthorCount !== 1 ? 's' : ''} excluded
                from analysis due to folder scope settings.{' '}
                {onNavigateToScope && (
                  <button
                    type="button"
                    onClick={onNavigateToScope}
                    className="inline-flex items-center min-h-[40px] px-1 underline underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                    aria-label="Configure scope"
                  >
                    Configure scope →
                  </button>
                )}
              </span>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {SEVERITY_ORDER.map((severity) => {
        const group = grouped.get(severity)!;
        if (group.length === 0) return null;
        const cfg = SEVERITY_CONFIG[severity];
        return (
          <Alert
            key={severity}
            className={cfg.alertClassName}
            data-testid={`warnings-group-${severity}`}
          >
            <AlertDescription>
              <div className="flex items-start gap-3">
                <Badge
                  variant="outline"
                  className={`shrink-0 mt-0.5 text-[10px] px-1.5 py-0 ${cfg.badgeClassName}`}
                >
                  {cfg.label}
                </Badge>
                <ul className="flex-1 space-y-1.5">
                  {group.map((w) => (
                    <li key={w.code} className="flex items-start gap-1.5 text-sm">
                      <span className="flex-1 leading-snug">{formatMessage(w)}</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Why: ${w.code}`}
                            className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                          >
                            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="top" className="text-sm leading-relaxed">
                          {WARNING_EXPLANATION[w.code]}
                        </PopoverContent>
                      </Popover>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
