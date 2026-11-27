import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ExportData } from '@devchain/shared';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import type { BackendId } from '@/ui/lib/api-transport';
import type { WizardConfigHandlers, WizardConfigState } from './wizardConfigTypes';
import { useProviderCatalogs, type ProviderCatalogs } from './useProviderCatalogs';
import { setupProviderList, type SetupProvider } from './providerSelection';

/**
 * Everything the setup review sections read: the preview, the lifted wizard state, its handlers,
 * the model/effort catalogs, and the provider list. Sections take no props, so each flow composes
 * the sections it needs.
 */
export interface SetupReviewContextValue {
  preview: SetupPreviewResponse;
  state: WizardConfigState;
  handlers: WizardConfigHandlers;
  catalogs: ProviderCatalogs;
  providers: SetupProvider[];
}

const SetupReviewContext = createContext<SetupReviewContextValue | null>(null);

export function SetupReviewProvider({
  preview,
  state,
  handlers,
  backend,
  currentExport,
  children,
}: Omit<SetupReviewContextValue, 'catalogs' | 'providers'> & {
  /** The backend that answered the preview; the catalogs are read from it. */
  backend: BackendId;
  currentExport?: ExportData | null;
  children: ReactNode;
}) {
  const catalogs = useProviderCatalogs(preview, backend);
  const providers = useMemo(
    () => setupProviderList(preview, currentExport),
    [preview, currentExport],
  );
  const value = useMemo(
    () => ({ preview, state, handlers, catalogs, providers }),
    [preview, state, handlers, catalogs, providers],
  );
  return <SetupReviewContext.Provider value={value}>{children}</SetupReviewContext.Provider>;
}

export function useSetupReview(): SetupReviewContextValue {
  const value = useContext(SetupReviewContext);
  if (!value) throw new Error('useSetupReview must be used inside SetupReviewProvider');
  return value;
}
