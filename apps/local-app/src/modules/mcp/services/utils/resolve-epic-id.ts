import { z } from 'zod';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { McpResponse } from '../../dtos/mcp.dto';

const uuidCheck = z.string().uuid();

export async function resolveEpicId(
  storage: StorageService,
  projectId: string,
  idOrPrefix: string,
): Promise<McpResponse> {
  // Full UUID — exact match, skip LIKE query
  if (uuidCheck.safeParse(idOrPrefix).success) {
    return { success: true, data: { epicId: idOrPrefix } };
  }

  const matches = await storage.getEpicsByIdPrefix(projectId, idOrPrefix);

  if (matches.length === 0) {
    return {
      success: false,
      error: {
        code: 'EPIC_NOT_FOUND',
        message: `No epic found matching prefix '${idOrPrefix}'`,
      },
    };
  }

  if (matches.length > 1) {
    const listing = matches
      .slice(0, 10)
      .map((m) => `${m.id} (${m.title})`)
      .join(', ');
    const suffix = matches.length > 10 ? ` … and ${matches.length - 10} more` : '';
    return {
      success: false,
      error: {
        code: 'AMBIGUOUS_EPIC',
        message: `Multiple epics match prefix '${idOrPrefix}': ${listing}${suffix}. Use a longer prefix or full UUID.`,
        data: {
          matchingEpics: matches.slice(0, 10),
          totalMatches: matches.length,
        },
      },
    };
  }

  return { success: true, data: { epicId: matches[0].id } };
}
