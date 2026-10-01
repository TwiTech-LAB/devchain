import { ProjectFrozenError, ProjectRemoteError } from '../../../../common/errors/error-types';
import type { McpResponse } from '../../dtos/mcp.dto';

/** The structured MCP form of a refused project write, or null for any other error. */
export function toProjectAdmissionErrorResponse(error: unknown): McpResponse | null {
  if (error instanceof ProjectFrozenError || error instanceof ProjectRemoteError) {
    return {
      success: false,
      error: { code: error.code, message: error.message, data: error.details },
    };
  }
  return null;
}
