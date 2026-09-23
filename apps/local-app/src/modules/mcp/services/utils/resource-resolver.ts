import type { PromptStorage } from '../../../storage/interfaces/storage.interface';
import { mapPromptDetail } from '../mappers/dto-mappers';
import type { McpResponse } from '../../dtos/mcp.dto';

export class ResourceResolver {
  constructor(private readonly storage: PromptStorage) {}

  async resolve(uri: string): Promise<McpResponse> {
    if (uri.startsWith('prompt://')) {
      return this.resolvePromptResource(uri);
    }

    return {
      success: false,
      error: {
        code: 'UNKNOWN_RESOURCE',
        message: `Unknown resource: ${uri}`,
      },
    };
  }

  private async resolvePromptResource(uri: string): Promise<McpResponse> {
    const spec = uri.slice('prompt://'.length);
    if (!spec) {
      throw new Error(`Invalid prompt resource URI: ${uri}`);
    }

    const atIndex = spec.lastIndexOf('@');
    const namePart = atIndex === -1 ? spec : spec.slice(0, atIndex);
    const versionPart = atIndex === -1 ? undefined : spec.slice(atIndex + 1);

    const name = decodeURIComponent(namePart).trim();
    if (!name) {
      throw new Error(`Prompt name missing in URI: ${uri}`);
    }

    let version: number | undefined;
    if (versionPart && versionPart.length > 0) {
      version = Number(versionPart);
      if (!Number.isFinite(version) || version <= 0) {
        throw new Error(`Invalid prompt version in URI: ${uri}`);
      }
    }

    const list = await this.storage.listPrompts({ projectId: null });
    const candidates = list.items.filter(
      (prompt) => prompt.title === name && (version === undefined || prompt.version === version),
    );

    const selected = candidates.find((prompt) => prompt.projectId === null) ?? candidates[0];

    if (!selected) {
      return {
        success: false,
        error: {
          code: 'PROMPT_NOT_FOUND',
          message: `Prompt not found: ${name}${version ? `@${version}` : ''}`,
        },
      };
    }

    const prompt = await this.storage.getPrompt(selected.id);

    return {
      success: true,
      data: {
        uri,
        mimeType: 'text/markdown',
        content: prompt.content,
        prompt: mapPromptDetail(prompt),
      },
    };
  }
}
