import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import type { DockerFilesystem } from '../../core/controllers/docker-runtime';
import { DockerImageMetadataSchema } from '../../core/controllers/docker-image-metadata';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const projectId = z.string().uuid();
const labels = z.record(z.string()).default({});
const scanPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
export const DockerOwnerSchema = z.object({ projectId, projectRoot: scanPath.optional() }).strict();
export const DockerIdsSchema = z.object({ ids: z.array(identifier).max(10000) }).strict();
// Docker allows a bracketed IPv6 registry, e.g. [2001:db8::1]:5000/app:latest.
const imageReference = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9])[a-zA-Z0-9_.:/@-]*$/);
export const DockerImageMatchRequestSchema = z
  .object({ refs: z.array(imageReference).max(10000) })
  .strict();
export const DockerImageMatchResultSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            ref: imageReference,
            id: identifier,
            metadata: DockerImageMetadataSchema,
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type DockerImageMatchResult = z.infer<typeof DockerImageMatchResultSchema>;
export const DockerVolumeCreateSchema = z.object({ projectId, name: identifier, labels }).strict();
export const DockerNetworkCreateSchema = z
  .object({
    projectId,
    name: identifier,
    labels,
    internal: z.boolean().default(false),
    attachable: z.boolean().default(false),
    options: z.record(z.string()).default({}),
    ipam: z
      .object({
        Config: z
          .array(
            z
              .object({
                Subnet: z.string().min(1).max(64),
                Gateway: z.string().ip({ version: 'v4' }).optional(),
                IPRange: z.string().min(1).max(64).optional(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    // A network several projects use, not made by Compose; an older VM refuses it.
    shared: z.literal(true).optional(),
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
    // `file`: a bound single file; an older VM refuses it instead of misplacing the file.
    mountType: z.enum(['volume', 'bind', 'file']),
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
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export interface DockerHostOptions {
  signal?: AbortSignal;
  apiVersion?: string;
}
export interface DockerOwnerOptions extends DockerHostOptions {
  projectRoot?: string;
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

export const DockerBindPrepareSchema = z
  .object({
    projectId,
    paths: z
      .array(
        z
          .object({
            path: scanPath,
            replace: z.boolean(),
            image: identifier.optional(),
            // A single file: only its folder is created, and the restore replaces the path.
            file: z.literal(true).optional(),
          })
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

/**
 * The answer of `POST images/load`: per image the engine just loaded, the ID the
 * engine assigned (which differs from the archive's ID on a containerd-store
 * engine), its `RootFS.Layers` digests, and the resolving load-stream aliases.
 */
export const DockerImageLoadResultSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            layers: z.array(z.string().min(1).max(256)).max(10000),
            references: z.array(z.string().min(1).max(256)).max(10000).optional(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type DockerImageLoadResult = z.infer<typeof DockerImageLoadResultSchema>;

export const DockerScanRequestSchema = z
  .object({
    paths: z.array(scanPath).max(64).default([]),
    volumes: z.array(identifier).max(10000).optional(),
    networks: z.array(identifier).max(10000).optional(),
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
  routes?: string[];
  networks?: Array<{
    name: string;
    subnets: string[];
    addresses?: Array<{ address: string; containerId: string; containerName: string }>;
  }>;
  architecture: string;
  containers: Array<{
    id: string;
    image?: string;
    metadata?: DockerHolderMetadata;
    name: string;
    labels: Record<string, string>;
    mounts: Array<{ type: string; name?: string; source?: string; destination: string }>;
  }>;
  volumes: Array<{ name: string; driver: string; labels: Record<string, string> }>;
  /** `file` marks an existing single file; anything else is a folder. */
  paths: Array<{ path: string; exists: boolean; file?: true } | { path: string; unknown: true }>;
}
