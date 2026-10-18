import type { ComponentProps } from 'react';
import { SharedVmGuardDialog } from './SharedVmGuardDialog';

export function ResetVmDialog({
  onReset,
  ...props
}: Omit<ComponentProps<typeof SharedVmGuardDialog>, 'action' | 'onConfirm'> & {
  onReset: ComponentProps<typeof SharedVmGuardDialog>['onConfirm'];
}): JSX.Element {
  return <SharedVmGuardDialog {...props} action="reset" onConfirm={onReset} />;
}
