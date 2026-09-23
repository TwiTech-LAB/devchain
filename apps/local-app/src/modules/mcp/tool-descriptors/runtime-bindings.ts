import { sessionBindings } from './session.bindings';
import { promptBindings } from './prompt.bindings';
import { skillBindings } from './skill.bindings';
import { agentBindings } from './agent.bindings';
import { epicBindings } from './epic.bindings';
import { recordBindings } from './record.bindings';
import { chatBindings } from './chat.bindings';
import { projectBindings } from './project.bindings';
import { teamBindings } from './team.bindings';
import { reviewBindings } from './review.bindings';

export const allBindingGroups = Object.freeze([
  sessionBindings,
  promptBindings,
  skillBindings,
  agentBindings,
  epicBindings,
  recordBindings,
  chatBindings,
  projectBindings,
  teamBindings,
  reviewBindings,
]);

export const allBindingDefinitions = Object.freeze(allBindingGroups.flat());
