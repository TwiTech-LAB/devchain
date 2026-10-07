import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);
const strings = z.array(z.string());
const keySet = z.record(z.object({}).strict());
const healthcheck = z
  .object({
    Test: strings.nullish(),
    Interval: z.number().int().nonnegative().nullish(),
    Timeout: z.number().int().nonnegative().nullish(),
    StartPeriod: z.number().int().nonnegative().nullish(),
    StartInterval: z.number().int().nonnegative().nullish(),
    Retries: z.number().int().nonnegative().nullish(),
  })
  .catchall(jsonValue);

const imageConfig = z
  .object({
    User: z.string().nullish(),
    Env: strings.nullish(),
    Cmd: strings.nullish(),
    Entrypoint: strings.nullish(),
    WorkingDir: z.string().nullish(),
    Labels: z.record(z.string()).nullish(),
    Volumes: keySet.nullish(),
    ExposedPorts: keySet.nullish(),
    OnBuild: strings.nullish(),
    Shell: strings.nullish(),
    StopSignal: z.string().nullish(),
    ArgsEscaped: z.boolean().nullish(),
    Healthcheck: healthcheck.nullish(),
    Memory: z.number().int().nullish(),
    MemorySwap: z.number().int().nullish(),
    CpuShares: z.number().int().nullish(),
    Hostname: z.string().nullish(),
    Domainname: z.string().nullish(),
    Image: z.string().nullish(),
    MacAddress: z.string().nullish(),
    AttachStdin: z.boolean().nullish(),
    AttachStdout: z.boolean().nullish(),
    AttachStderr: z.boolean().nullish(),
    Tty: z.boolean().nullish(),
    OpenStdin: z.boolean().nullish(),
    StdinOnce: z.boolean().nullish(),
    NetworkDisabled: z.boolean().nullish(),
    StopTimeout: z.number().int().nonnegative().nullish(),
  })
  .catchall(jsonValue);

export const DockerImageMetadataSchema = z
  .object({
    Os: z.string().min(1).max(256),
    Architecture: z.string().min(1).max(256),
    Variant: z.string().max(256).nullish(),
    Created: z.union([z.literal(''), z.string().datetime({ offset: true })]).nullish(),
    Config: imageConfig,
    RootFS: z.object({ Layers: z.array(z.string().min(1).max(256)).max(10000) }).strict(),
  })
  .strict();

export interface DockerImageInspectMetadata {
  Os?: unknown;
  Architecture?: unknown;
  Variant?: unknown;
  Created?: unknown;
  Config?: unknown;
  RootFS?: { Layers?: unknown } | null;
}

export function dockerImageMetadata(image: DockerImageInspectMetadata): Record<string, unknown> {
  return {
    Os: image.Os,
    Architecture: image.Architecture,
    Variant: image.Variant,
    Created: image.Created,
    Config: image.Config,
    RootFS: { Layers: image.RootFS?.Layers },
  };
}

const configDefaults: Record<string, JsonValue> = {
  User: '',
  Env: [],
  Cmd: [],
  Entrypoint: [],
  WorkingDir: '',
  Labels: {},
  Volumes: {},
  ExposedPorts: {},
  OnBuild: [],
  Shell: [],
  StopSignal: '',
  ArgsEscaped: false,
  Memory: 0,
  MemorySwap: 0,
  CpuShares: 0,
  // Compared after its own defaults are removed (healthcheckDefaults).
  Healthcheck: {},
  // Older inspect APIs include these container-only fields at their zero values.
  Hostname: '',
  Domainname: '',
  Image: '',
  MacAddress: '',
  AttachStdin: false,
  AttachStdout: false,
  AttachStderr: false,
  Tty: false,
  OpenStdin: false,
  StdinOnce: false,
  NetworkDisabled: false,
  StopTimeout: 0,
};
const healthcheckDefaults: Record<string, JsonValue> = {
  Test: [],
  Interval: 0,
  Timeout: 0,
  StartPeriod: 0,
  StartInterval: 0,
  Retries: 0,
};

function withoutDefaults(
  fields: Record<string, unknown>,
  defaults: Record<string, JsonValue>,
): Record<string, unknown> {
  const result = { ...fields };
  for (const [field, empty] of Object.entries(defaults)) {
    if (result[field] == null || isDeepStrictEqual(result[field], empty)) delete result[field];
  }
  return result;
}

function normalizeDockerImageMetadata(value: unknown): Record<string, unknown> | null {
  const parsed = DockerImageMetadataSchema.safeParse(value);
  if (!parsed.success) return null;
  const image = parsed.data;
  const config = withoutDefaults(
    {
      ...image.Config,
      Healthcheck: withoutDefaults(image.Config.Healthcheck ?? {}, healthcheckDefaults),
    },
    configDefaults,
  );
  return {
    Os: image.Os,
    Architecture: image.Architecture,
    Variant: image.Variant ?? '',
    Created: image.Created === '0001-01-01T00:00:00Z' ? '' : (image.Created ?? ''),
    Config: config,
    RootFS: image.RootFS,
  };
}

export function dockerImageMetadataMatches(home: unknown, vm: unknown): boolean {
  const normalizedHome = normalizeDockerImageMetadata(home);
  const normalizedVm = normalizeDockerImageMetadata(vm);
  return (
    normalizedHome !== null &&
    normalizedVm !== null &&
    isDeepStrictEqual(normalizedHome, normalizedVm)
  );
}

/**
 * The VM image that every home tag names, when it has the home image's content.
 * Otherwise undefined, and Connect uploads the image.
 */
export function vmImageIdForTags(
  home: DockerImageInspectMetadata,
  tags: string[],
  vmImages: Array<{ ref: string; id: string; metadata: unknown }>,
): string | undefined {
  const homeMetadata = dockerImageMetadata(home);
  const matches = tags.map((tag) => vmImages.filter((candidate) => candidate.ref === tag));
  const first = matches[0]?.[0];
  const all = matches.every(
    (entries) =>
      entries.length === 1 &&
      entries[0].id === first?.id &&
      dockerImageMetadataMatches(homeMetadata, entries[0].metadata),
  );
  return first && all ? first.id : undefined;
}
