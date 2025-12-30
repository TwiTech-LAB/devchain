/**
 * Registry API response interfaces
 */

export interface RegistryTemplateListItem {
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  requiredProviders: string[];
  isOfficial: boolean;
  latestVersion: string | null;
  totalDownloads: number;
  updatedAt: string;
}

export interface TemplateListResponse {
  templates: RegistryTemplateListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface RegistryTemplateVersion {
  version: string;
  minDevchainVersion: string | null;
  changelog: string | null;
  publishedAt: string;
  downloadCount: number;
  isLatest: boolean;
}

export interface RegistryTemplateDetail {
  slug: string;
  name: string;
  description: string | null;
  authorName: string | null;
  license: string | null;
  category: string | null;
  tags: string[];
  requiredProviders: string[];
  isOfficial: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDetailResponse {
  template: RegistryTemplateDetail;
  versions: RegistryTemplateVersion[];
}

export interface DownloadResult {
  content: Record<string, unknown>;
  checksum: string;
  slug: string;
  version: string;
}

export interface InstalledTemplate {
  slug: string;
  version: string;
}

export interface UpdateInfo {
  slug: string;
  currentVersion: string;
  latestVersion: string;
  changelog: string | null;
}

export interface ListTemplatesQuery {
  search?: string;
  category?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sort?: 'name' | 'downloads' | 'updated';
  order?: 'asc' | 'desc';
}
