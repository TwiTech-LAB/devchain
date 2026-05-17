import type { SkillsService } from '../../../skills/services/skills.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export interface SkillToolContext {
  skillsService: SkillsService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
