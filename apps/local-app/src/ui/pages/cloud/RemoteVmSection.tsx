import { useRemoteVmSectionController } from '@/ui/hooks/useRemoteVmSectionController';
import { RemoteVmSectionView } from './RemoteVmSectionView';

export function RemoteVmSection() {
  const presentation = useRemoteVmSectionController();
  return <RemoteVmSectionView presentation={presentation} />;
}
