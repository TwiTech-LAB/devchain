import { createContext, useContext, type ReactNode } from 'react';
import type { RemoteVmApi } from './remote-vm-api';
import { remoteVmHttpApi } from './remote-vm-http-api';

const RemoteVmApiContext = createContext<RemoteVmApi>(remoteVmHttpApi);

export function RemoteVmApiProvider({ api, children }: { api: RemoteVmApi; children: ReactNode }) {
  return <RemoteVmApiContext.Provider value={api}>{children}</RemoteVmApiContext.Provider>;
}

export function useRemoteVmApi(): RemoteVmApi {
  return useContext(RemoteVmApiContext);
}
