import { z } from 'zod';

export const DockerSelectionModeSchema = z.enum([
  'container-and-data',
  'without-data',
  'data-only',
]);
export const DockerDataChoiceSchema = z.enum(['keep-vm', 'replace-home']);
export type DockerDataChoice = z.infer<typeof DockerDataChoiceSchema>;
export const DockerSelectionItemSchema = z
  .object({
    id: z.string().min(1).max(512),
    mode: DockerSelectionModeSchema,
    dataChoice: DockerDataChoiceSchema.optional(),
  })
  .strict();
/** Only item identities and choices; the server re-scans and builds what moves itself. */
export const DockerSelectionSchema = z
  .object({ items: z.array(DockerSelectionItemSchema).max(1000) })
  .strict();
export const DockerPlanRequestSchema = z
  .object({
    remoteId: z.string().uuid(),
    items: DockerSelectionSchema.shape.items.optional(),
  })
  .strict();
export type DockerPlanRequest = z.infer<typeof DockerPlanRequestSchema>;
export type DockerSelectionMode = z.infer<typeof DockerSelectionModeSchema>;
export type DockerSelectionItem = z.infer<typeof DockerSelectionItemSchema>;
/** The attach request's Docker selection, kept in the operation's initial details. */
export type DockerSelection = z.infer<typeof DockerSelectionSchema>;
export interface DockerPlanSize {
  bytes: number;
  unknown: boolean;
}
export interface DockerPlanIssue {
  code: string;
  message: string;
}
export interface DockerPlanMount {
  kind:
    | 'named-volume'
    | 'anonymous-volume'
    | 'project-bind'
    | 'home-bind'
    | 'readonly-external-bind'
    | 'external-bind';
  source: string;
  destination: string;
  readOnly: boolean;
  size: DockerPlanSize;
  driver?: string;
}
/** The mount kinds whose data an import copies. */
export const COPYABLE_MOUNT_KINDS: readonly DockerPlanMount['kind'][] = [
  'named-volume',
  'anonymous-volume',
  'project-bind',
  'home-bind',
];
export function isVolumeMount(kind: DockerPlanMount['kind']): boolean {
  return kind === 'named-volume' || kind === 'anonymous-volume';
}
export interface DockerPlanImage {
  id: string;
  architecture: string;
  size: DockerPlanSize;
}
export interface DockerPlanItem {
  dataState?: DockerDataState;
  dataGroup?: string[];
  dataChoice?: DockerDataChoice;
  dataAction?: DockerDataChoice;
  dataChoiceRequired?: boolean;
  missingData?: DockerDataMembers;
  id: string;
  kind: 'container' | 'compose-project';
  name: string;
  composeProject: string | null;
  linkedReasons: string[];
  defaultSelected: boolean;
  selectedMode: DockerSelectionMode | null;
  choices: DockerSelectionMode[];
  temporary: boolean;
  images: DockerPlanImage[];
  mounts: DockerPlanMount[];
  writerGroup: string[];
  /**
   * Unselected home containers that Connect stops because they write data this
   * item copies; the same rule as the handoff's stop list (`writerStops`).
   */
  alsoStops: string[];
  blockers: DockerPlanIssue[];
  warnings: DockerPlanIssue[];
  notes: string[];
  writableLayer: DockerPlanSize;
  targetAction: 'create' | 'replace' | 'leave-as-is' | 'conflict' | 'data-only';
}
export interface DockerPlanFilesystem {
  filesystemId: string | null;
  paths: string[];
  requiredBytes: number;
  headroomBytes: number;
  freeBytes: number | null;
  unknown: boolean;
  status: 'fits' | 'warning' | 'refused' | 'unknown';
}
export interface DockerPlan {
  dataGroups?: DockerDataGroupCheck[];
  projectId: string;
  remoteId: string;
  scannedAt: string;
  availability: {
    available: boolean;
    side: 'home' | 'remote' | null;
    reason: DockerPlanIssue | null;
  };
  apiVersion: string | null;
  items: DockerPlanItem[];
  filesystems: DockerPlanFilesystem[];
  fit: 'fits' | 'warning' | 'refused' | 'unknown';
  canConnect: boolean;
  warnings: DockerPlanIssue[];
  managedExclusions: string[];
  reconnect: { importedAt: string; replacing: string[]; lossNotice: string } | null;
  estimate: {
    minSeconds: number;
    maxSeconds: number;
    probeBytes: number;
    loadTailKnown: false;
    approximate: true;
  } | null;
}
/** `details.docker`, published through the runner's progress hook. */
export interface DockerTransferDetails {
  bytesDone: number;
  bytesTotal: number;
  /** Null until five seconds of samples exist. */
  rateBytesPerSecond: number | null;
  etaSeconds: number | null;
  item: { name: string; phase: 'image' | 'volume' | 'bind' | 'network' | 'container' } | null;
  /** Previously imported VM copies this Connect replaces; a cancel does not restore them. */
  replaced: string[];
  result?: { withoutData: string[]; dataOnly: string[] };
}

export const DOCKER_WRITABLE_LAYER_NOTE =
  'Volume data is copied. Changes made inside the container itself are not; they are normally installed packages, not project data.';
export const DOCKER_TEMPORARY_NOTE =
  'temporary (`--rm`) container: only its named volumes move; Docker removes the container when it stops';

export interface DockerDataMembers {
  volumes: string[];
  /** Absolute paths, including copied home binds outside the project. */
  bindPaths: string[];
}
export interface DockerDataGroup extends DockerDataMembers {
  itemIds: string[];
}
export type DockerDataState =
  | 'in-sync'
  | 'vm-newer'
  | 'home-newer'
  | 'both-changed'
  | 'unknown'
  | 'no-record';
export interface DockerDataGroupCheck extends DockerDataGroup {
  state: DockerDataState;
}
