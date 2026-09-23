import type { ToolMetadataEntry } from './types';

import { sessionMetadata } from './session.metadata';
import { promptMetadata } from './prompt.metadata';
import { skillMetadata } from './skill.metadata';
import { agentMetadata } from './agent.metadata';
import { epicMetadata } from './epic.metadata';
import { recordMetadata } from './record.metadata';
import { chatMetadata } from './chat.metadata';
import { teamMetadata } from './team.metadata';
import { reviewMetadata } from './review.metadata';
import { projectMetadata } from './project.metadata';

export const allMetadata: ToolMetadataEntry[] = [
  ...sessionMetadata,
  ...promptMetadata,
  ...skillMetadata,
  ...agentMetadata,
  ...epicMetadata,
  ...recordMetadata,
  ...chatMetadata,
  ...projectMetadata,
  ...teamMetadata,
  ...reviewMetadata,
];

export type { ToolMetadataEntry } from './types';
