import { ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { BreadcrumbItem } from '@/ui/components/shared/Breadcrumbs';

interface BreadcrumbsContextValue {
  items: BreadcrumbItem[];
  setBreadcrumbs: (items: BreadcrumbItem[]) => void;
  clearBreadcrumbs: () => void;
}

const BreadcrumbsContext = createContext<BreadcrumbsContextValue | undefined>(undefined);

export function BreadcrumbsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<BreadcrumbItem[]>([]);

  const setBreadcrumbs = useCallback((next: BreadcrumbItem[]) => {
    setItems(next);
  }, []);

  const clearBreadcrumbs = useCallback(() => {
    setItems([]);
  }, []);

  const value = useMemo(
    () => ({
      items,
      setBreadcrumbs,
      clearBreadcrumbs,
    }),
    [items, setBreadcrumbs, clearBreadcrumbs],
  );

  return <BreadcrumbsContext.Provider value={value}>{children}</BreadcrumbsContext.Provider>;
}

export function useBreadcrumbs() {
  const context = useContext(BreadcrumbsContext);
  if (!context) {
    throw new Error('useBreadcrumbs must be used within a BreadcrumbsProvider');
  }
  return context;
}
