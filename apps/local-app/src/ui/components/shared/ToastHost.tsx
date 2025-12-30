import { ComponentPropsWithoutRef, PropsWithChildren } from 'react';
import { ToastProvider } from '@/ui/components/ui/toast';
import { Toaster } from '@/ui/components/ui/toaster';

type ToastHostProps = PropsWithChildren<ComponentPropsWithoutRef<typeof ToastProvider>>;

export function ToastHost({ children, ...providerProps }: ToastHostProps) {
  return (
    <ToastProvider {...providerProps}>
      {children}
      <Toaster />
    </ToastProvider>
  );
}
