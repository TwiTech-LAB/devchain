import { z } from 'zod';

export const ProbeAddressSchema = z
  .object({
    /** `https://host[:port]`, or a bare `host[:port]` that is read as https. */
    address: z.string().trim().min(1).max(2048),
    checkSsh: z.boolean().optional().default(true),
  })
  .strict();

export type ProbeAddressData = z.infer<typeof ProbeAddressSchema>;

/** What answers at an address; never creates a remote or an operation. */
export type ProbeResultDto =
  | {
      kind: 'devchain';
      baseUrl: string;
      version: string | null;
      versionMatches: boolean;
      homePath: string | null;
      homePathMatches: boolean | null;
      /** The registered remote at this origin, if any. */
      remoteId: string | null;
    }
  | {
      kind: 'installer';
      bootstrapUrl: string;
      state: string;
      imageVersion: string | null;
      /** The image is at least the oldest one a claim accepts. */
      supported: boolean;
      /** The remote registered for the DevChain this installer will start, if any. */
      remoteId: string | null;
    }
  | {
      kind: 'nothing';
      /** Every origin probed. */
      tried: string[];
      /** Whether port 22 accepts a connection; null when the check was skipped. */
      sshReachable: boolean | null;
    };

export interface RemoteReadinessDto {
  syncthing: { ok: boolean; version: string | null; message: string | null };
  identity: { ok: boolean; user: string; homePath: string; message: string | null };
  docker: { ok: boolean; message: string | null };
}
