import type { SharedVmNotice } from '../host/shared-vm.contract';

export interface RemoteNoticeDto extends SharedVmNotice {
  remoteId: string;
}
