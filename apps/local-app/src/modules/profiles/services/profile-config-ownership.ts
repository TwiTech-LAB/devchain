import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { ProfileProviderConfigStorage } from '../../storage/interfaces/storage.interface';
import type { ProfileProviderConfig } from '../../storage/models/domain.models';

/**
 * The codes an agent config edit and a restore switch answer for a config the agent cannot use.
 * Clients read them, so both writers share these builders.
 */
export function configNotFound(configId: string): ValidationError {
  return new ValidationError('Provider config not found', { code: 'CONFIG_NOT_FOUND', configId });
}

/** Never names the config's own profile: it may belong to another project. */
export function configProfileMismatch(configId: string, profileId: string): ValidationError {
  return new ValidationError('Provider config does not belong to the selected profile', {
    code: 'CONFIG_PROFILE_MISMATCH',
    configId,
    expectedProfileId: profileId,
  });
}

/**
 * The config, when it exists and belongs to `profileId`. Only "config does not exist" is
 * CONFIG_NOT_FOUND; other storage failures pass through.
 */
export async function getProfileConfigOrThrow(
  storage: Pick<ProfileProviderConfigStorage, 'getProfileProviderConfig'>,
  configId: string,
  profileId: string,
): Promise<ProfileProviderConfig> {
  let config: ProfileProviderConfig;
  try {
    config = await storage.getProfileProviderConfig(configId);
  } catch (error) {
    if (error instanceof NotFoundError) throw configNotFound(configId);
    throw error;
  }
  if (config.profileId !== profileId) throw configProfileMismatch(configId, profileId);
  return config;
}
