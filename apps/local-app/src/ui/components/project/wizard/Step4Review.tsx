import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import type { PromptTransferCounts } from '@/common/prompt-transfer';

export interface ImportDryRunCounts {
  toImport: Record<string, number>;
  toDelete: Record<string, number>;
}

export interface ImportUnmatchedStatus {
  id: string;
  label: string;
  color: string;
  epicCount: number;
}

export interface ImportDryRunReview {
  counts: ImportDryRunCounts;
  unmatchedStatuses?: ImportUnmatchedStatus[];
  templateStatuses?: Array<{ label: string; color: string }>;
  missingProviders?: string[];
  promptTransfer?: PromptTransferCounts;
}

export interface Step4ReviewProps {
  /** The dry-run result computed from all wizard selections (null while loading / before run). */
  review: ImportDryRunReview | null;
  /** True while the dry-run is in flight. */
  isLoading: boolean;
  /** Unmatched-status → template-status-label map (only meaningful when unmatchedStatuses exist). */
  statusMappings: Record<string, string>;
  onStatusMappingChange: (statusId: string, templateLabel: string) => void;
}

/**
 * Wizard final step — Review & Confirm (import). Extracted VERBATIM from the legacy `ImportConfirmDialog`
 * body: the to-import / will-delete counts (ALWAYS shown) plus a conditional status-mapping section
 * (rendered ONLY when the dry-run reports unmatched statuses). The destructive "Import" action is the
 * wizard footer's submit on this last step — the controller gates it on the dry-run having loaded and
 * every required status mapping being filled. This preserves today's DESTRUCTIVE-COUNTS confirmation.
 *
 * Counts + status mapping are kept as one review surface (as the legacy dialog was) rather than split
 * across two wizard steps: the dry-run is async and fires on entry to this step, so a preceding
 * "status mappings" step would have no data to gate on until this step runs — merging avoids that
 * ordering hazard while keeping the status section strictly conditional.
 */
export function Step4Review({
  review,
  isLoading,
  statusMappings,
  onStatusMappingChange,
}: Step4ReviewProps) {
  if (isLoading || !review) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground"
        data-testid="wizard-review-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Computing import changes…
      </div>
    );
  }

  const unmatched = review.unmatchedStatuses ?? [];

  return (
    <div className="space-y-3 text-sm" data-testid="wizard-review-step">
      <p className="text-muted-foreground">
        This will REPLACE prompts, profiles, agents, statuses, and the initial session prompt for
        this project. This action is destructive.
      </p>

      {review.missingProviders && review.missingProviders.length > 0 && (
        <Alert variant="destructive" data-testid="wizard-review-missing-providers">
          <AlertDescription>
            Missing providers: {review.missingProviders.join(', ')}. Install them or adjust the
            provider selection in Step 1.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <strong>To import</strong>
        <div className="mt-1 grid grid-cols-2 gap-2" data-testid="wizard-review-import-counts">
          {Object.entries(review.counts.toImport).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="capitalize">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <strong>Will delete</strong>
        <div className="mt-1 grid grid-cols-2 gap-2" data-testid="wizard-review-delete-counts">
          {Object.entries(review.counts.toDelete).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="capitalize">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {review.promptTransfer && (
        <div data-testid="wizard-review-prompt-transfer">
          <strong>Prompt transfer</strong>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {Object.entries(review.promptTransfer).map(([key, value]) => (
              <div key={key} className="flex justify-between">
                <span className="capitalize">{key}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="mt-3 border-t pt-3" data-testid="wizard-review-status-mappings">
          <strong>Status Mapping Required</strong>
          <p className="mb-2 mt-1 text-xs text-muted-foreground">
            The following statuses have epics but no matching status in the template. Map each to a
            template status:
          </p>
          <div className="space-y-2">
            {unmatched.map((status) => (
              <div key={status.id} className="flex items-center gap-2">
                <div className="flex min-w-[140px] items-center gap-1.5">
                  <span
                    style={{ backgroundColor: status.color }}
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  />
                  <span className="truncate">{status.label}</span>
                  <span className="text-xs text-muted-foreground">({status.epicCount})</span>
                </div>
                <span className="text-muted-foreground">→</span>
                <Select
                  value={statusMappings[status.id] || ''}
                  onValueChange={(val) => onStatusMappingChange(status.id, val)}
                >
                  <SelectTrigger
                    className="w-[140px]"
                    aria-label={`Map status ${status.label}`}
                    data-testid={`wizard-status-map-${status.id}`}
                  >
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {review.templateStatuses?.map((ts) => (
                      <SelectItem key={ts.label} value={ts.label}>
                        <div className="flex items-center gap-1.5">
                          <span
                            style={{ backgroundColor: ts.color }}
                            className="h-2 w-2 rounded-full"
                          />
                          {ts.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** True when the dry-run reports unmatched statuses not yet mapped (blocks the final Import). */
export function hasUnmappedStatuses(
  review: ImportDryRunReview | null,
  statusMappings: Record<string, string>,
): boolean {
  const unmatched = review?.unmatchedStatuses ?? [];
  return unmatched.some((status) => !statusMappings[status.id]);
}
