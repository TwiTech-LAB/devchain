import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { fetchPreflightChecks } from '@/ui/lib/preflight';

function getStatusIcon(status: 'pass' | 'fail' | 'warn') {
  switch (status) {
    case 'pass':
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    case 'fail':
      return <XCircle className="h-5 w-5 text-destructive" />;
    case 'warn':
      return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
    default:
      return null;
  }
}

export function SystemSection() {
  const navigate = useNavigate();
  const { selectedProject } = useSelectedProject();
  const projectPath = selectedProject?.rootPath;

  const {
    data: preflightResult,
    refetch: refetchPreflight,
    isLoading: preflightLoading,
    isRefetching,
  } = useQuery({
    queryKey: ['preflight', projectPath ?? 'global'],
    queryFn: () => fetchPreflightChecks(projectPath),
    refetchInterval: 60000,
    staleTime: 60000,
  });

  return (
    <div className="space-y-6">
      {/* Preflight Checks */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>System Preflight Checks</CardTitle>
              <CardDescription>
                Verify that all required dependencies and configurations are correct
              </CardDescription>
              {selectedProject && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Target project:{' '}
                  <span className="font-semibold text-foreground">{selectedProject.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground/80">
                    {selectedProject.rootPath}
                  </span>
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchPreflight()}
              disabled={isRefetching}
            >
              {isRefetching ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {preflightLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Running preflight checks...</span>
            </div>
          )}

          {preflightResult && (
            <div className="space-y-4">
              {/* Overall Status */}
              <Alert variant={preflightResult.overall === 'fail' ? 'destructive' : 'default'}>
                {getStatusIcon(preflightResult.overall)}
                <AlertTitle>Overall Status: {preflightResult.overall.toUpperCase()}</AlertTitle>
                <AlertDescription>
                  {preflightResult.overall === 'pass' && 'All systems operational'}
                  {preflightResult.overall === 'warn' && 'Some checks have warnings'}
                  {preflightResult.overall === 'fail' &&
                    'Some checks failed. Session launch will be blocked.'}
                </AlertDescription>
              </Alert>

              {/* Individual Checks */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  System Checks
                </h3>
                {preflightResult.checks.map((check) => (
                  <Card
                    key={check.name}
                    className={
                      check.status === 'fail'
                        ? 'border-destructive'
                        : check.status === 'warn'
                          ? 'border-yellow-600'
                          : 'border-green-600'
                    }
                  >
                    <CardContent className="pt-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">{getStatusIcon(check.status)}</div>
                        <div className="flex-1">
                          <h4 className="font-semibold mb-1">{check.name}</h4>
                          <p className="text-sm text-muted-foreground mb-2">{check.message}</p>
                          {check.details && (
                            <div className="text-xs bg-muted p-2 rounded font-mono">
                              {check.details}
                            </div>
                          )}
                          {check.remediation && (
                            <div className="mt-2 text-xs text-muted-foreground">
                              <strong>How to fix:</strong> {check.remediation}
                            </div>
                          )}
                        </div>
                        <Badge
                          variant={
                            check.status === 'pass'
                              ? 'default'
                              : check.status === 'fail'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {check.status.toUpperCase()}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Provider Checks */}
              {preflightResult.providers && preflightResult.providers.length > 0 && (
                <div className="space-y-3 mt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Provider Checks
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {preflightResult.providers.length} provider
                      {preflightResult.providers.length !== 1 ? 's' : ''} configured
                    </p>
                  </div>
                  {preflightResult.providers.map((provider) => (
                    <Card
                      key={provider.id}
                      className={
                        provider.status === 'fail'
                          ? 'border-destructive'
                          : provider.status === 'warn'
                            ? 'border-yellow-600'
                            : 'border-green-600'
                      }
                    >
                      <CardContent className="pt-4">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5">{getStatusIcon(provider.status)}</div>
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center justify-between">
                              <h4 className="font-semibold">{provider.name}</h4>
                              <Badge
                                variant={
                                  provider.status === 'pass'
                                    ? 'default'
                                    : provider.status === 'fail'
                                      ? 'destructive'
                                      : 'secondary'
                                }
                              >
                                {provider.status.toUpperCase()}
                              </Badge>
                            </div>
                            {provider.binPath && (
                              <div className="text-xs bg-muted p-2 rounded font-mono">
                                {provider.binPath}
                              </div>
                            )}
                            <div className="flex flex-col gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                  variant="secondary"
                                  className={
                                    provider.binaryStatus === 'fail'
                                      ? 'border border-destructive bg-destructive/10 text-destructive'
                                      : provider.binaryStatus === 'warn'
                                        ? 'border border-yellow-600 bg-yellow-500/10 text-yellow-700'
                                        : 'border border-emerald-500 bg-emerald-500/10 text-emerald-600'
                                  }
                                >
                                  Binary {provider.binaryStatus.toUpperCase()}
                                </Badge>
                                <span className="text-sm text-muted-foreground">
                                  {provider.binaryMessage}
                                </span>
                              </div>
                              {provider.mcpStatus && (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge
                                    variant="secondary"
                                    className={
                                      provider.mcpStatus === 'fail'
                                        ? 'border border-destructive bg-destructive/10 text-destructive'
                                        : provider.mcpStatus === 'warn'
                                          ? 'border border-yellow-600 bg-yellow-500/10 text-yellow-700'
                                          : 'border border-emerald-500 bg-emerald-500/10 text-emerald-600'
                                    }
                                  >
                                    MCP {provider.mcpStatus.toUpperCase()}
                                  </Badge>
                                  <span className="text-sm text-muted-foreground">
                                    {provider.mcpMessage ?? 'MCP not required.'}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted-foreground mt-4">
                Last checked: {new Date(preflightResult.timestamp).toLocaleString()}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Provider Management */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Management</CardTitle>
          <CardDescription>Configure AI provider binaries and settings</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Manage Providers</AlertTitle>
            <AlertDescription>
              Provider configurations, including binary paths, are now managed through the dedicated{' '}
              <a href="/providers" className="font-semibold underline hover:text-primary">
                Providers
              </a>{' '}
              page. You can add, edit, and configure provider binaries there.
            </AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button variant="outline" onClick={() => navigate('/providers')}>
              Go to Providers
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
