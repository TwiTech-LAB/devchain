import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, Link2Off } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import {
  IntegrationConnectionApiError,
  type IntegrationConnectionState,
  type IntegrationProvider,
  type ReplaceIntegrationConnectionInput,
} from '@/ui/hooks/useIntegrationConnections';
import { externalBoardProviderLabel } from '@/ui/lib/external-board';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

interface IntegrationConnectionFormProps {
  provider: IntegrationProvider;
  connection: IntegrationConnectionState;
  onReplace: (input: ReplaceIntegrationConnectionInput) => Promise<unknown>;
  onDisconnect: (
    provider: IntegrationProvider,
    acknowledgeOrphanRisk?: boolean,
  ) => Promise<unknown>;
  isReplacing?: boolean;
  isDisconnecting?: boolean;
  requiresOrphanRiskAcknowledgement?: boolean;
  connectionControls?: ReactNode;
}

type FieldName = 'token' | 'siteUrl' | 'email';
type FieldErrors = Partial<Record<FieldName, string>>;

export function IntegrationConnectionForm({
  provider,
  connection,
  onReplace,
  onDisconnect,
  isReplacing = false,
  isDisconnecting = false,
  requiresOrphanRiskAcknowledgement = false,
  connectionControls,
}: IntegrationConnectionFormProps) {
  const [token, setToken] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [subtaskSyncEnabled, setSubtaskSyncEnabled] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const [serverRequiresOrphanAcknowledgement, setServerRequiresOrphanAcknowledgement] =
    useState(false);
  const label = externalBoardProviderLabel(provider);

  const clearFieldError = (field: FieldName) => {
    setFieldErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setFormError(null);
    setSuccessMessage(null);
  };

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!token.trim()) {
      errors.token =
        provider === 'clickup'
          ? 'Personal API token is required.'
          : 'Classic API token is required.';
    }
    if (provider === 'jira') {
      if (!connection.connected) {
        if (!siteUrl.trim()) errors.siteUrl = 'Jira site URL is required.';
        if (!email.trim()) errors.email = 'Account email is required.';
      } else if (siteUrl.trim() && !email.trim()) {
        errors.email = 'Account email is required when changing the site URL.';
      } else if (email.trim() && !siteUrl.trim()) {
        errors.siteUrl = 'Jira site URL is required when changing the account email.';
      }
    }
    return errors;
  };

  const buildReplacementInput = (): ReplaceIntegrationConnectionInput =>
    provider === 'clickup'
      ? {
          provider,
          token: token.trim(),
          ...(!connection.connected ? { subtaskSyncEnabled } : {}),
        }
      : {
          provider,
          token: token.trim(),
          ...(siteUrl.trim() && email.trim()
            ? { siteUrl: siteUrl.trim(), email: email.trim() }
            : {}),
          ...(!connection.connected ? { subtaskSyncEnabled } : {}),
        };

  const performReplacement = async (acknowledgeOrphanRisk = false) => {
    const input = buildReplacementInput();
    try {
      setFieldErrors({});
      setFormError(null);
      await onReplace({ ...input, ...(acknowledgeOrphanRisk ? { acknowledgeOrphanRisk } : {}) });
      setToken('');
      setSiteUrl('');
      setEmail('');
      setSubtaskSyncEnabled(false);
      setConfirmReplacement(false);
      setServerRequiresOrphanAcknowledgement(false);
      setSuccessMessage(`${label} credentials saved.`);
    } catch (error) {
      if (
        error instanceof IntegrationConnectionApiError &&
        error.providerReason === 'orphan_risk_ack_required' &&
        !acknowledgeOrphanRisk
      ) {
        setServerRequiresOrphanAcknowledgement(true);
        setConfirmReplacement(true);
        return;
      }
      if (error instanceof IntegrationConnectionApiError && error.field) {
        const field = error.field as FieldName;
        if (field === 'token' || field === 'siteUrl' || field === 'email') {
          setFieldErrors({ [field]: error.message });
          return;
        }
      }
      setFormError(getErrorMessage(error, `${label} credentials could not be saved.`));
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    if (connection.connected && requiresOrphanRiskAcknowledgement) {
      setConfirmReplacement(true);
      return;
    }
    await performReplacement();
  };

  const handleSiteUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSiteUrl(event.target.value);
    clearFieldError('siteUrl');
  };

  const handleEmailChange = (event: ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    clearFieldError('email');
  };

  const handleTokenChange = (event: ChangeEvent<HTMLInputElement>) => {
    setToken(event.target.value);
    clearFieldError('token');
  };

  const handleOpenDisconnect = () => setConfirmDisconnect(true);

  const handleDisconnect = () => {
    const acknowledgeOrphanRisk =
      requiresOrphanRiskAcknowledgement || serverRequiresOrphanAcknowledgement;
    void onDisconnect(provider, acknowledgeOrphanRisk)
      .then(() => {
        setConfirmDisconnect(false);
        setServerRequiresOrphanAcknowledgement(false);
        setSuccessMessage(`${label} disconnected.`);
      })
      .catch((error: unknown) => {
        if (
          error instanceof IntegrationConnectionApiError &&
          error.providerReason === 'orphan_risk_ack_required'
        ) {
          setServerRequiresOrphanAcknowledgement(true);
          setConfirmDisconnect(true);
          return;
        }
        setFormError(getErrorMessage(error, `${label} could not be disconnected.`));
      });
  };

  const handleConfirmedReplacement = () => {
    void performReplacement(true);
  };

  const submitLabel = connection.connected ? `Replace ${label} credentials` : `Connect ${label}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{label}</CardTitle>
          <Badge variant={connection.connected ? 'default' : 'secondary'}>
            {connection.connected ? 'Connected' : 'Not connected'}
          </Badge>
        </div>
        <CardDescription>
          {provider === 'clickup'
            ? 'Connect with a ClickUp personal API token.'
            : 'Connect a Jira Cloud site with your account email and API token.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          {provider === 'jira' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="jira-site-url">Jira site URL</Label>
                <Input
                  id="jira-site-url"
                  type="url"
                  value={siteUrl}
                  placeholder={
                    connection.connected
                      ? 'Leave blank to reuse saved site'
                      : 'https://team.atlassian.net'
                  }
                  onChange={handleSiteUrlChange}
                  aria-invalid={fieldErrors.siteUrl ? true : undefined}
                  aria-describedby={fieldErrors.siteUrl ? 'jira-site-url-error' : undefined}
                  disabled={isReplacing}
                />
                {fieldErrors.siteUrl && (
                  <p id="jira-site-url-error" className="text-sm text-destructive">
                    {fieldErrors.siteUrl}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="jira-account-email">Account email</Label>
                <Input
                  id="jira-account-email"
                  type="email"
                  value={email}
                  placeholder={
                    connection.connected ? 'Leave blank to reuse saved email' : 'you@example.com'
                  }
                  onChange={handleEmailChange}
                  aria-invalid={fieldErrors.email ? true : undefined}
                  aria-describedby={fieldErrors.email ? 'jira-account-email-error' : undefined}
                  disabled={isReplacing}
                />
                {fieldErrors.email && (
                  <p id="jira-account-email-error" className="text-sm text-destructive">
                    {fieldErrors.email}
                  </p>
                )}
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor={`${provider}-api-token`}>
              {provider === 'clickup' ? 'Personal API token' : 'Classic API token (without scopes)'}
            </Label>
            <Input
              id={`${provider}-api-token`}
              type="password"
              value={token}
              autoComplete="off"
              onChange={handleTokenChange}
              aria-invalid={fieldErrors.token ? true : undefined}
              aria-describedby={fieldErrors.token ? `${provider}-api-token-error` : undefined}
              disabled={isReplacing}
            />
            {fieldErrors.token && (
              <p id={`${provider}-api-token-error`} className="text-sm text-destructive">
                {fieldErrors.token}
              </p>
            )}
            {provider === 'jira' && (
              <p className="text-xs text-muted-foreground">
                <span>Use a classic Jira API token without scopes.</span>{' '}
                <span>Scoped Jira API tokens may not work with this connection yet.</span>
              </p>
            )}
          </div>

          {!connection.connected && (
            <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 p-3">
              <div className="space-y-1">
                <Label htmlFor={`${provider}-managed-subtask-sync`}>
                  Sync DevChain sub-epics as managed subtasks
                </Label>
                <p className="text-xs text-muted-foreground">
                  One-way sync of parent, title, description, creation, and deletion. Status and
                  comments stay unchanged.
                </p>
              </div>
              <Switch
                id={`${provider}-managed-subtask-sync`}
                checked={subtaskSyncEnabled}
                onCheckedChange={setSubtaskSyncEnabled}
                disabled={isReplacing}
              />
            </div>
          )}

          {connection.connected && provider === 'jira' && (
            <p className="text-xs text-muted-foreground">
              Leave both site URL and email blank to reuse the encrypted saved values.
            </p>
          )}

          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          {successMessage && (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>{successMessage}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={isReplacing || isDisconnecting}>
              {isReplacing ? 'Validating…' : submitLabel}
            </Button>
            {connection.connected && (
              <Button
                type="button"
                variant="outline"
                disabled={isReplacing || isDisconnecting}
                onClick={handleOpenDisconnect}
              >
                <Link2Off className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            )}
          </div>
        </form>
        {connectionControls}
      </CardContent>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        onConfirm={handleDisconnect}
        title={`Disconnect ${label}?`}
        description={
          requiresOrphanRiskAcknowledgement || serverRequiresOrphanAcknowledgement
            ? 'Unresolved admitted sync work may already exist remotely. Disconnecting removes the only usable credential context and can leave remote subtasks orphaned.'
            : 'The saved credential will be removed. Existing linked Epic snapshots remain available.'
        }
        confirmText={
          requiresOrphanRiskAcknowledgement || serverRequiresOrphanAcknowledgement
            ? 'Acknowledge possible remote orphan'
            : 'Disconnect'
        }
        variant="destructive"
        loading={isDisconnecting}
      />
      <ConfirmDialog
        open={confirmReplacement}
        onOpenChange={setConfirmReplacement}
        onConfirm={handleConfirmedReplacement}
        title={`Replace ${label} credentials?`}
        description="Unresolved admitted sync work may already exist remotely. Replacing the only usable credential context can leave remote subtasks orphaned. Continue only after checking the provider."
        confirmText="Acknowledge possible remote orphan"
        variant="destructive"
        loading={isReplacing}
      />
    </Card>
  );
}
