import type { PromptSummary as StoragePromptSummary } from '../../../storage/interfaces/storage.interface';
import type {
  Document,
  Prompt,
  Status,
  Epic,
  EpicComment,
  Skill,
} from '../../../storage/models/domain.models';
import type {
  DocumentDetail,
  DocumentSummary,
  PromptSummary,
  PromptDetail,
  SkillListItem,
  GetSkillResponse,
  StatusSummary,
  EpicSummary,
  EpicCommentSummary,
  EpicChildSummary,
  EpicParentSummary,
} from '../../dtos/mcp.dto';

export function mapStatusSummary(status: Status): StatusSummary {
  return {
    id: status.id,
    name: status.label,
    position: status.position,
    color: status.color,
  };
}

export function mapEpicSummary(epic: Epic, agentNameById?: Map<string, string>): EpicSummary {
  const summary: EpicSummary = {
    id: epic.id,
    title: epic.title,
    description: epic.description ?? null,
    statusId: epic.statusId,
    version: epic.version,
  };

  if (epic.agentId && agentNameById) {
    const agentName = agentNameById.get(epic.agentId);
    if (agentName) {
      summary.agentName = agentName;
    }
  }

  if (epic.parentId) {
    summary.parentId = epic.parentId;
  }

  // Always include tags (empty array if none)
  summary.tags = epic.tags ?? [];
  // Always include skillsRequired (empty array if none)
  summary.skillsRequired = epic.skillsRequired ?? [];

  return summary;
}

export function mapEpicChild(epic: Epic): EpicChildSummary {
  return {
    id: epic.id,
    title: epic.title,
    statusId: epic.statusId,
  };
}

export function mapEpicParent(epic: Epic, agentNameById: Map<string, string>): EpicParentSummary {
  return {
    id: epic.id,
    title: epic.title,
    description: epic.description ?? null,
    agentName: epic.agentId ? (agentNameById.get(epic.agentId) ?? null) : null,
  };
}

export function mapEpicComment(comment: EpicComment): EpicCommentSummary {
  return {
    id: comment.id,
    authorName: comment.authorName,
    content: comment.content,
    createdAt: comment.createdAt,
  };
}

export function mapDocumentSummary(document: Document): DocumentSummary {
  return {
    id: document.id,
    projectId: document.projectId,
    title: document.title,
    slug: document.slug,
    tags: document.tags,
    archived: document.archived,
    version: document.version,
    updatedAt: document.updatedAt,
  };
}

export function mapDocumentDetail(document: Document): DocumentDetail {
  const summary = mapDocumentSummary(document);
  return {
    ...summary,
    contentMd: document.contentMd,
    createdAt: document.createdAt,
  };
}

export function mapPromptSummary(prompt: StoragePromptSummary): PromptSummary {
  return {
    id: prompt.id,
    projectId: prompt.projectId,
    title: prompt.title,
    contentPreview: prompt.contentPreview,
    tags: prompt.tags,
    version: prompt.version,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
  };
}

export function mapPromptDetail(prompt: Prompt): PromptDetail {
  const PREVIEW_LENGTH = 200;
  const contentPreview =
    prompt.content.length > PREVIEW_LENGTH
      ? prompt.content.slice(0, PREVIEW_LENGTH) + '…'
      : prompt.content;

  return {
    id: prompt.id,
    projectId: prompt.projectId,
    title: prompt.title,
    contentPreview,
    content: prompt.content,
    tags: prompt.tags,
    version: prompt.version,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
  };
}

export function mapSkillListItem(skill: Skill): SkillListItem {
  const description =
    skill.shortDescription ||
    (skill.description ? skill.description.slice(0, 120) : 'No description available');

  return {
    slug: skill.slug,
    description,
  };
}

export function mapSkillDetail(skill: Skill): GetSkillResponse {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    instructionContent: skill.instructionContent,
    contentPath: skill.contentPath,
    resources: skill.resources,
    sourceUrl: skill.sourceUrl,
    license: skill.license,
    compatibility: skill.compatibility,
    status: skill.status,
    frontmatter: skill.frontmatter,
  };
}
