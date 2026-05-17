export class ServiceUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE' as const;

  constructor(serviceName: string) {
    super(`${serviceName} requires full app context (not available in standalone MCP mode)`);
    this.name = 'ServiceUnavailableError';
  }
}
