import { z } from 'zod';
import { DockerSelectionModeSchema, type DockerPlanItem } from './docker/docker-plan.dto';

const ConnectDockerChoiceSchema = z
  .object({ included: z.boolean(), mode: DockerSelectionModeSchema.optional() })
  .strict();
export const ConnectLastChoicesSchema = z
  .object({
    remoteId: z.string().min(1),
    includeDocker: z.boolean(),
    items: z.record(ConnectDockerChoiceSchema),
    savedAt: z.string().datetime(),
  })
  .strict();

export type ConnectDockerChoice = z.infer<typeof ConnectDockerChoiceSchema>;
/** The key of an item's remembered choice; plan item IDs change between scans. */
export const connectChoiceKey = (item: Pick<DockerPlanItem, 'kind' | 'name'>) =>
  `${item.kind}:${item.name}`;
export type ConnectLastChoices = z.infer<typeof ConnectLastChoicesSchema>;
export interface ConnectChoicesDto {
  git: 'present' | 'missing';
  remoteId?: string;
  includeDocker: boolean;
}
