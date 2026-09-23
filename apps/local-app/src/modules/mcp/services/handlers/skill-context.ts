import type { SkillsService } from '../../../skills/services/skills.service';
import type { SkillSourceLifecycleService } from '../../../skills/services/skill-source-lifecycle.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export interface SkillToolContext {
  skillsService: SkillsService;
  skillSourceLifecycleService: SkillSourceLifecycleService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
