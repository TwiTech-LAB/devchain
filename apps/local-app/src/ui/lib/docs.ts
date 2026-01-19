/**
 * Documentation system types and utilities
 */

/**
 * Supported documentation categories
 */
export type DocCategory = 'guides' | 'reference' | 'tutorials';

/**
 * Frontmatter metadata parsed from markdown documentation files
 */
export interface DocFrontmatter {
  title: string;
  description: string;
  slug: string;
  category: DocCategory;
  tags: string[];
}

/**
 * A complete documentation entry with parsed frontmatter and content
 */
export interface DocEntry {
  slug: string;
  frontmatter: DocFrontmatter;
  content: string;
}

/**
 * Maps feature identifiers to documentation slugs
 * Used by HelpButton to resolve which doc to show for a UI element
 */
export const FEATURE_DOC_MAP: Record<string, string> = {
  reviews: 'code-review',
};

/**
 * Parse a raw markdown string with YAML frontmatter into a DocEntry
 *
 * Expected format:
 * ```
 * ---
 * title: "Title"
 * description: "Description"
 * slug: "slug-name"
 * category: "guides"
 * tags: ["tag1", "tag2"]
 * ---
 * Content here...
 * ```
 *
 * @param raw - Raw markdown string with frontmatter
 * @returns Parsed DocEntry
 * @throws Error if frontmatter is missing or malformed
 */
export function parseFrontmatter(raw: string): DocEntry {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = raw.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid markdown: missing frontmatter delimiters (---)');
  }

  const [, frontmatterBlock, content] = match;
  const frontmatter = parseFrontmatterBlock(frontmatterBlock);

  return {
    slug: frontmatter.slug,
    frontmatter,
    content: content.trim(),
  };
}

/**
 * Parse the YAML-like frontmatter block into DocFrontmatter
 * Simple parser - does not support full YAML spec
 */
function parseFrontmatterBlock(block: string): DocFrontmatter {
  const lines = block.split(/\r?\n/);
  const data: Record<string, string | string[]> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.substring(0, colonIndex).trim();
    let value = trimmed.substring(colonIndex + 1).trim();

    // Handle quoted strings
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Handle arrays (simple JSON-like syntax)
    if (value.startsWith('[') && value.endsWith(']')) {
      try {
        data[key] = JSON.parse(value);
      } catch {
        // If JSON parse fails, treat as empty array
        data[key] = [];
      }
    } else {
      data[key] = value;
    }
  }

  // Validate required fields
  const required = ['title', 'description', 'slug', 'category'];
  for (const field of required) {
    if (!data[field]) {
      throw new Error(`Missing required frontmatter field: ${field}`);
    }
  }

  // Validate category
  const validCategories: DocCategory[] = ['guides', 'reference', 'tutorials'];
  if (!validCategories.includes(data.category as DocCategory)) {
    throw new Error(
      `Invalid category: ${data.category}. Must be one of: ${validCategories.join(', ')}`,
    );
  }

  return {
    title: data.title as string,
    description: data.description as string,
    slug: data.slug as string,
    category: data.category as DocCategory,
    tags: Array.isArray(data.tags) ? data.tags : [],
  };
}
