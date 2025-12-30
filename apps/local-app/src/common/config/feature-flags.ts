export interface FeatureFlagConfig {
  enableProfileInstructionTemplates: boolean;
  enableDocumentTemplateVariables: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlagConfig = {
  enableProfileInstructionTemplates: false,
  enableDocumentTemplateVariables: false,
};
