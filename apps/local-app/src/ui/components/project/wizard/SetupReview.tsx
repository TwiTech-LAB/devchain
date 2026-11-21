import type { ReactNode } from 'react';
import {
  CreatedAgentsSection,
  FallbackNotice,
  ProvidersSection,
  SetupPresetSection,
} from './SetupReviewSections';
import {
  ReplacePrecheckAlert,
  ReplacePrecheckPending,
  useReplacePrecheck,
} from './ReplacePrecheck';
import { CurrentSetupRemovals, ReplaceSetupSection, useCurrentSetup } from './KeepCurrentSetup';
import { OptionalAdditions, PreservedRosterReview } from './PreservedRosterReview';

function SetupReviewLayout({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div
      className="grid items-start gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
      data-testid="wizard-setup-review"
    >
      <div className="min-w-0 space-y-5">{left}</div>
      <div className="min-w-0 space-y-5">{right}</div>
    </div>
  );
}

/** The roster that the template creates: the fallback notice, then the teams and agents. */
function TemplateRoster() {
  return (
    <>
      <FallbackNotice />
      <CreatedAgentsSection />
    </>
  );
}

export function CreateReview() {
  return (
    <SetupReviewLayout
      left={
        <>
          <ProvidersSection />
          <SetupPresetSection />
        </>
      }
      right={<TemplateRoster />}
    />
  );
}

export function ReplaceReview() {
  const { selected } = useCurrentSetup();
  const precheck = useReplacePrecheck();
  let roster = <TemplateRoster />;
  if (selected) {
    roster = precheck.isPending ? <ReplacePrecheckPending /> : <PreservedRosterReview />;
  }
  return (
    <div className="space-y-5">
      <ReplacePrecheckAlert {...precheck} />
      {!selected && precheck.isPending && <ReplacePrecheckPending />}
      <SetupReviewLayout
        left={
          <>
            <ProvidersSection />
            <ReplaceSetupSection />
            {selected && <OptionalAdditions />}
          </>
        }
        right={
          <>
            {roster}
            <CurrentSetupRemovals />
          </>
        }
      />
    </div>
  );
}
