import type { PromptSummary as StoragePromptSummary } from '../../../storage/interfaces/storage.interface';
import type {
  Prompt,
  Status,
  Epic,
  EpicComment,
  Skill,
} from '../../../storage/models/domain.models';
import type {
  PromptSummary,
  PromptDetail,
  SkillListItem,
  GetSkillResponse,
  StatusSummary,
  EpicSummary,
  EpicListItem,
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
    createdBy: epic.createdBy,
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
  };
}

const EPIC_DESCRIPTION_PREVIEW_LIMIT = 300;

/**
 * Bounded description preview for list responses: the first 300 characters,
 * cut back to the last word boundary (a first word longer than the limit is
 * hard-cut at 300), with an ellipsis only when text was actually cut.
 */
export function buildDescriptionPreview(description: string | null): {
  descriptionPreview: string | null;
  descriptionLength: number;
} {
  if (!description) {
    return { descriptionPreview: null, descriptionLength: 0 };
  }
  if (description.length <= EPIC_DESCRIPTION_PREVIEW_LIMIT) {
    return { descriptionPreview: description, descriptionLength: description.length };
  }
  const hardCut = description.slice(0, EPIC_DESCRIPTION_PREVIEW_LIMIT);
  const boundary = hardCut.lastIndexOf(' ');
  const cut = boundary > 0 ? hardCut.slice(0, boundary) : hardCut;
  return { descriptionPreview: `${cut}…`, descriptionLength: description.length };
}

/**
 * Item shape of devchain_list_epics: the summary without the full description
 * by default (preview plus full length instead), or with it when
 * `includeDescription` is set. Other epic surfaces keep `mapEpicSummary`.
 */
export function mapEpicListItem(
  epic: Epic,
  agentNameById?: Map<string, string>,
  includeDescription = false,
): EpicListItem {
  const { description, ...rest } = mapEpicSummary(epic, agentNameById);
  if (includeDescription) {
    return { ...rest, description };
  }
  return { ...rest, ...buildDescriptionPreview(description) };
}

export function mapEpicParent(
  epic: Epic,
  agentNameById: Map<string, string>,
  statusLabel?: string,
  includeDescription = false,
): EpicParentSummary {
  const summary: EpicParentSummary = {
    id: epic.id,
    title: epic.title,
    agentName: epic.agentId ? (agentNameById.get(epic.agentId) ?? null) : null,
  };
  if (statusLabel) {
    summary.status = statusLabel;
  }
  if (includeDescription) {
    summary.description = epic.description ?? null;
  }
  return summary;
}

export function mapEpicComment(comment: EpicComment): EpicCommentSummary {
  return {
    id: comment.id,
    authorName: comment.authorName,
    content: comment.content,
    createdAt: comment.createdAt,
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
  return {
    id: prompt.id,
    projectId: prompt.projectId,
    title: prompt.title,
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

const DUPLICATED_FRONTMATTER_KEYS: readonly string[] = [
  'name',
  'description',
  'license',
  'compatibility',
  'resources',
];

/**
 * Response copy of the skill frontmatter with the keys dropped that the
 * detail already carries as top-level fields; the stored value stays
 * untouched. `version` has no top-level twin and always survives. Collapses
 * to null when nothing unique remains.
 */
function filterFrontmatterForResponse(
  frontmatter: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!frontmatter) {
    return null;
  }
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!DUPLICATED_FRONTMATTER_KEYS.includes(key)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
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
    frontmatter: filterFrontmatterForResponse(skill.frontmatter),
  };
}
