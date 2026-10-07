import { MODULE_METADATA } from '@nestjs/common/constants';
import { McpFullModule } from './mcp-full.module';
import { McpToolBindingRegistry } from './services/mcp-tool-binding.registry';

function isForwardReference(value: unknown): value is { forwardRef: () => unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'forwardRef' in value &&
    typeof value.forwardRef === 'function'
  );
}

function moduleName(value: unknown): string | undefined {
  if (typeof value === 'function') return value.name;
  if (isForwardReference(value)) {
    const resolved = value.forwardRef();
    return typeof resolved === 'function' ? resolved.name : undefined;
  }
  return undefined;
}

describe('McpFullModule', () => {
  it('keeps the full composition import graph fixed', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, McpFullModule) ??
      []) as unknown[];

    expect(imports.map(moduleName)).toEqual([
      'StorageModule',
      'EventsCoreModule',
      'SessionsModule',
      'TerminalModule',
      'EpicsModule',
      'SettingsModule',
      'GuestsModule',
      'ReviewsModule',
      'SkillsModule',
      'TeamsModule',
      'AgentMessageDeliveryModule',
      'ProjectCommunicationModule',
      'ProjectWriteAdmissionModule',
    ]);
    expect(imports.filter(isForwardReference).map(moduleName)).toEqual([
      'SessionsModule',
      'EpicsModule',
      'SettingsModule',
      'GuestsModule',
      'ReviewsModule',
      'TeamsModule',
      'AgentMessageDeliveryModule',
    ]);
  });

  it('provides the binding registry privately', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, McpFullModule) ??
      []) as unknown[];
    const exports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, McpFullModule) ??
      []) as unknown[];

    expect(providers).toContain(McpToolBindingRegistry);
    expect(exports).not.toContain(McpToolBindingRegistry);
  });
});
