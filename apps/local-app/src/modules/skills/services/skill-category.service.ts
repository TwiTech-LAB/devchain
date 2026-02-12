import { Injectable } from '@nestjs/common';

export type SkillCategory =
  | 'security'
  | 'testing'
  | 'deployment'
  | 'documents'
  | 'design'
  | 'integration'
  | 'creative'
  | 'communication'
  | 'development';

interface CategoryRule {
  category: Exclude<SkillCategory, 'development'>;
  patterns: readonly RegExp[];
}

const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'security',
    patterns: [
      /\bsecurity\b/,
      /\bsecure\b/,
      /\bowasp\b/,
      /\bvulnerab(?:ility|ilities)\b/,
      /\bauth(?:entication|orization)?\b/,
      /\bencrypt(?:ion|ed)?\b/,
      /\bthreat\b/,
      /\bcve\b/,
      /\bcsrf\b/,
      /\bxss\b/,
      /\bcompliance\b/,
      /\bsecret(?:s)?\b/,
      /\b(?:pen(?:etration)?|pentest)\b/,
    ],
  },
  {
    category: 'testing',
    patterns: [
      /\btest(?:ing|s)?\b/,
      /\bspec(?:s)?\b/,
      /\bcoverage\b/,
      /\bmock(?:ing|s)?\b/,
      /\bfixture(?:s)?\b/,
      /\bqa\b/,
      /\bassert(?:ion|ions)?\b/,
      /\be2e\b/,
    ],
  },
  {
    category: 'deployment',
    patterns: [
      /\bdeploy(?:ment|ing)?\b/,
      /\brelease\b/,
      /\brollout\b/,
      /\bkubernetes\b/,
      /\bk8s\b/,
      /\bdocker\b/,
      /\bterraform\b/,
      /\bci\/cd\b/,
      /\bpipeline(?:s)?\b/,
      /\bhosting\b/,
      /\bcloudflare\b/,
      /\bvercel\b/,
      /\bnetlify\b/,
      /\brender\b/,
    ],
  },
  {
    category: 'documents',
    patterns: [
      /\bdocs?\b/,
      /\bdocument(?:ation|s)?\b/,
      /\breadme\b/,
      /\bknowledge\b/,
      /\bnotion\b/,
      /\bconfluence\b/,
      /\bpdf\b/,
      /\bspreadsheet(?:s)?\b/,
      /\breport(?:s)?\b/,
    ],
  },
  {
    category: 'design',
    patterns: [
      /\bdesign\b/,
      /\bfigma\b/,
      /\bprototype(?:s)?\b/,
      /\bwireframe(?:s)?\b/,
      /\bui\b/,
      /\bux\b/,
      /\bstyle\s*guide\b/,
      /\bvisual\b/,
    ],
  },
  {
    category: 'integration',
    patterns: [
      /\bintegration(?:s)?\b/,
      /\bapi(?:s)?\b/,
      /\bwebhook(?:s)?\b/,
      /\bconnector(?:s)?\b/,
      /\bmcp\b/,
      /\bsdk(?:s)?\b/,
      /\bplugin(?:s)?\b/,
      /\bthird[- ]party\b/,
      /\bsync\b/,
    ],
  },
  {
    category: 'creative',
    patterns: [
      /\bcreative\b/,
      /\bimage(?:gen)?\b/,
      /\bvideo\b/,
      /\baudio\b/,
      /\bmusic\b/,
      /\bstory\b/,
      /\billustration\b/,
      /\bart\b/,
      /\bsora\b/,
      /\bspeech\b/,
    ],
  },
  {
    category: 'communication',
    patterns: [
      /\bcommunicat(?:e|ion)\b/,
      /\bemail\b/,
      /\bmessage(?:s)?\b/,
      /\bchat\b/,
      /\bslack\b/,
      /\bteams\b/,
      /\bmeeting(?:s)?\b/,
      /\bpresentation(?:s)?\b/,
      /\btranscribe\b/,
      /\bsummar(?:ize|y)\b/,
    ],
  },
] as const;

@Injectable()
export class SkillCategoryService {
  deriveCategory(
    name?: string | null,
    description?: string | null,
    compatibility?: string | null,
  ): SkillCategory {
    const haystack = this.buildSearchText(name, description, compatibility);

    for (const rule of CATEGORY_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(haystack))) {
        return rule.category;
      }
    }

    return 'development';
  }

  private buildSearchText(
    name?: string | null,
    description?: string | null,
    compatibility?: string | null,
  ): string {
    return [name, description, compatibility]
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter((value) => value.length > 0)
      .join(' ');
  }
}
