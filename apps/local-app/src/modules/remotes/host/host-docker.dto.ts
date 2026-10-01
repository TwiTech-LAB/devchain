import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import type { DockerFilesystem } from '../../core/controllers/docker-runtime';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const projectId = z.string().uuid();
const labels = z.record(z.string()).default({});
export const DockerOwnerSchema = z.object({ projectId }).strict();
export const DockerIdsSchema = z.object({ ids: z.array(identifier).max(10000) }).strict();
export const DockerVolumeCreateSchema = z.object({ projectId, name: identifier, labels }).strict();
export const DockerNetworkCreateSchema = z
  .object({
    projectId,
    name: identifier,
    labels,
    internal: z.boolean().default(false),
    attachable: z.boolean().default(false),
    options: z.record(z.string()).default({}),
  })
  .strict();
export const DockerContainerCreateSchema = z
  .object({
    projectId,
    name: identifier,
    config: z.record(z.unknown()),
  })
  .strict();
export const DockerArchiveRequestSchema = z
  .object({
    projectId,
    image: identifier,
    mountType: z.enum(['volume', 'bind']),
    source: z.string().min(1).max(4096),
  })
  .strict();
export const DockerResourceIdSchema = identifier;
export type DockerVolumeCreate = z.infer<typeof DockerVolumeCreateSchema>;
export type DockerNetworkCreate = z.infer<typeof DockerNetworkCreateSchema>;
export type DockerContainerCreate = z.infer<typeof DockerContainerCreateSchema>;
export type DockerArchiveRequest = z.infer<typeof DockerArchiveRequestSchema>;
export interface DockerVolumeHolder {
  id: string;
  labels: Record<string, string>;
}
export const DOCKER_PROJECT_LABEL = 'dev.devchain.project';
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface DockerHostOptions {
  signal?: AbortSignal;
  apiVersion?: string;
}
export const DOCKER_API_VERSION_HEADER = 'x-devchain-docker-api-version';
/** HTTP trailer of `GET archive`: the sha256 of the archive bytes the VM sent. */
export const DOCKER_ARCHIVE_SHA256_TRAILER = 'x-devchain-archive-sha256';

export const DockerCapacityRequestSchema = z
  .object({ paths: z.array(z.string().min(1).max(4096)).max(64) })
  .strict();
export type DockerPathCapacity = DockerFilesystem | { path: string; unknown: true };
export interface DockerCapacityResult {
  paths: DockerPathCapacity[];
}

const scanPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
export const DockerBindPrepareSchema = z
  .object({
    projectId,
    paths: z
      .array(
        z
          .object({ path: scanPath, replace: z.boolean(), image: identifier.optional() })
          .strict()
          // A replaced folder is emptied by a helper running the owning item's image.
          .refine((bind) => !bind.replace || bind.image !== undefined),
      )
      .min(1)
      .max(64),
  })
  .strict();
export type DockerBindPrepare = z.infer<typeof DockerBindPrepareSchema>;
export const DockerArchiveWriteResultSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() })
  .strict();
export type DockerArchiveWriteResult = z.infer<typeof DockerArchiveWriteResultSchema>;

export const DockerScanRequestSchema = z
  .object({
    paths: z.array(scanPath).max(64).default([]),
    volumes: z.array(identifier).max(10000).optional(),
  })
  .strict();
/** When a data holder was created and started, and whether it runs: what the change check reads. */
export interface DockerHolderMetadata {
  created?: string;
  startedAt?: string;
  running?: boolean;
}
/** The part of a container inspect that `DockerHolderMetadata` comes from. */
export interface DockerInspectTimes {
  Created?: string;
  State?: { StartedAt?: string; Running?: boolean };
}
export interface DockerScanResult {
  architecture: string;
  containers: Array<{
    id: string;
    metadata?: DockerHolderMetadata;
    name: string;
    labels: Record<string, string>;
    mounts: Array<{ type: string; name?: string; source?: string; destination: string }>;
  }>;
  volumes: Array<{ name: string; driver: string; labels: Record<string, string> }>;
  paths: Array<{ path: string; exists: boolean } | { path: string; unknown: true }>;
}
