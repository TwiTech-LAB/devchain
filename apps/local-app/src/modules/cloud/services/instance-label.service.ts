import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/services/settings.service';

const MAX_LABEL_LENGTH = 128;

/**
 * The instance's display name in tunnel attestation (`label`). Home sets it to
 * the name it gave the remote so the phone lists a recognizable instance; a
 * null label falls back to the machine hostname.
 */
@Injectable()
export class InstanceLabelService {
  constructor(private readonly settings: SettingsService) {}

  getLabel(): string | null {
    const label = this.settings.getSettings().cloud?.instanceLabel?.trim();
    return label ? label : null;
  }

  /** Empty input clears the label; returns the stored value. */
  async setLabel(raw: string): Promise<string | null> {
    const label = raw.trim().slice(0, MAX_LABEL_LENGTH) || null;
    await this.settings.updateSettings({ cloud: { instanceLabel: label } });
    return label;
  }
}
