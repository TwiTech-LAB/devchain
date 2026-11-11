import { KeyRound } from 'lucide-react';
import type { ExportVaultAccess } from '@devchain/shared';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';

export function formatTemplateVaultAccess(vaultAccess: ExportVaultAccess): string {
  return vaultAccess.mode === 'all'
    ? 'This template turns on the Vault for: all agents'
    : `This template turns on the Vault for roles: ${vaultAccess.familySlugs.join(', ')}`;
}

/** Informational line for a template that carries Vault access; renders nothing when absent. */
export function TemplateVaultAccessNotice({
  vaultAccess,
}: {
  vaultAccess: ExportVaultAccess | undefined;
}) {
  if (!vaultAccess) return null;
  return (
    <Alert
      variant="info"
      role="status"
      className="py-2 [&>svg]:top-2.5"
      data-testid="wizard-vault-access-notice"
    >
      <KeyRound className="h-4 w-4" />
      <AlertDescription>{formatTemplateVaultAccess(vaultAccess)}</AlertDescription>
    </Alert>
  );
}
