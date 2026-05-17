import type { ToolMetadataEntry, ToolBindingEntry } from './types';

import { sessionMetadata } from './session.metadata';
import { sessionBindings } from './session.bindings';
import { documentMetadata } from './document.metadata';
import { documentBindings } from './document.bindings';
import { promptMetadata } from './prompt.metadata';
import { promptBindings } from './prompt.bindings';
import { skillMetadata } from './skill.metadata';
import { skillBindings } from './skill.bindings';
import { agentMetadata } from './agent.metadata';
import { agentBindings } from './agent.bindings';
import { epicMetadata } from './epic.metadata';
import { epicBindings } from './epic.bindings';
import { recordMetadata } from './record.metadata';
import { recordBindings } from './record.bindings';
import { chatMetadata } from './chat.metadata';
import { chatBindings } from './chat.bindings';
import { activityMetadata } from './activity.metadata';
import { activityBindings } from './activity.bindings';
import { teamMetadata } from './team.metadata';
import { teamBindings } from './team.bindings';
import { reviewMetadata } from './review.metadata';
import { reviewBindings } from './review.bindings';

export const allMetadata: ToolMetadataEntry[] = [
  ...sessionMetadata,
  ...documentMetadata,
  ...promptMetadata,
  ...skillMetadata,
  ...agentMetadata,
  ...epicMetadata,
  ...recordMetadata,
  ...chatMetadata,
  ...activityMetadata,
  ...teamMetadata,
  ...reviewMetadata,
];

export const allBindings: ToolBindingEntry[] = [
  ...sessionBindings,
  ...documentBindings,
  ...promptBindings,
  ...skillBindings,
  ...agentBindings,
  ...epicBindings,
  ...recordBindings,
  ...chatBindings,
  ...activityBindings,
  ...teamBindings,
  ...reviewBindings,
];

export type { ToolMetadataEntry, ToolBindingEntry } from './types';
