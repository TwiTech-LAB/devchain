import { createContext, useContext, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { ExportData } from '@devchain/shared';
import type { PreservationReview, PreserveTeamSetup } from '@/common/project-preservation.contract';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { canPreserveTeams, currentSetupRemovals } from './currentSetup';
import { SetupChoiceCard, SetupPresetSection, SummaryLine } from './SetupReviewSections';
import { useSetupReview } from './SetupReviewContext';

export interface CurrentSetupValue {
  currentExport: ExportData | null;
  selected: boolean;
  onKeep: () => void;
  onUseTemplate: () => void;
  plan?: PreservationReview;
  isReviewCurrent: boolean;
  choices: PreserveTeamSetup;
  onUpdateChoices: (update: (choices: PreserveTeamSetup) => PreserveTeamSetup) => void;
}

const CurrentSetupContext = createContext<CurrentSetupValue | null>(null);

export function CurrentSetupProvider({
  value,
  children,
}: {
  value: CurrentSetupValue;
  children: ReactNode;
}) {
  return <CurrentSetupContext.Provider value={value}>{children}</CurrentSetupContext.Provider>;
}

export function useCurrentSetup(): CurrentSetupValue {
  const value = useContext(CurrentSetupContext);
  if (!value) throw new Error('useCurrentSetup must be used inside CurrentSetupProvider');
  return value;
}

export function ReplaceSetupSection() {
  const current = useCurrentSetup();
  const { state } = useSetupReview();
  const offerKeep = canPreserveTeams(current.currentExport);
  return (
    <>
      {!current.currentExport && (
        <Alert variant="info" role="status" data-testid="wizard-current-setup-unavailable">
          <Info className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            The current setup could not be read. You can still use the template&rsquo;s setup.
          </AlertDescription>
        </Alert>
      )}
      <SetupPresetSection
        showPresetSelection={!current.selected}
        noPresetChoice={
          <SetupChoiceCard
            title="Use template defaults"
            checked={!current.selected && state.agentPresetName === null}
            onSelect={current.onUseTemplate}
          />
        }
      >
        {offerKeep && (
          <SetupChoiceCard
            title="Keep my current setup"
            checked={current.selected}
            onSelect={current.onKeep}
          >
            <span className="block text-xs text-muted-foreground">
              Keep your teams, their leads and members, and choose template additions.
            </span>
          </SetupChoiceCard>
        )}
      </SetupPresetSection>
    </>
  );
}

export function CurrentSetupRemovals() {
  const current = useCurrentSetup();
  const { preview } = useSetupReview();
  if (!current.currentExport || !current.isReviewCurrent || (current.selected && !current.plan)) {
    return null;
  }
  const agents = currentSetupRemovals(
    current.currentExport,
    preview.payload,
    current.selected ? current.plan : undefined,
  );
  return <SummaryLine label="Removed" items={agents} />;
}
