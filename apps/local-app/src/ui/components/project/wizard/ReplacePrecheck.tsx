import { createContext, useContext, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { formatProjectPreMutationFailure } from '@/ui/pages/projects/lib/project-failures';
import type { ProjectPreMutationFailure } from '@/ui/pages/projects/lib/project-contracts';

export interface ReplacePrecheckValue {
  /** Flow name for messages: "Import", "Upgrade" or "Update". */
  operationName: string;
  isPending: boolean;
  /** Why the replace cannot run, from the precheck or a commit that did not start. */
  failure: ProjectPreMutationFailure | null;
  /** Run the precheck again with the current setup. */
  onCheckAgain: () => void;
}

const ReplacePrecheckContext = createContext<ReplacePrecheckValue | null>(null);

export function ReplacePrecheckProvider({
  value,
  children,
}: {
  value: ReplacePrecheckValue;
  children: ReactNode;
}) {
  return (
    <ReplacePrecheckContext.Provider value={value}>{children}</ReplacePrecheckContext.Provider>
  );
}

export function useReplacePrecheck(): ReplacePrecheckValue {
  const value = useContext(ReplacePrecheckContext);
  if (!value) throw new Error('useReplacePrecheck must be used inside ReplacePrecheckProvider');
  return value;
}

export function ReplacePrecheckPending() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Checking project setup…
    </p>
  );
}

export function ReplacePrecheckAlert({
  operationName,
  isPending,
  failure,
  onCheckAgain,
}: ReplacePrecheckValue) {
  if (!failure || isPending) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>{operationName} blocked before making changes</AlertTitle>
      <AlertDescription className="break-words">
        {formatProjectPreMutationFailure(failure)}
      </AlertDescription>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onCheckAgain}>
        Check again
      </Button>
    </Alert>
  );
}
