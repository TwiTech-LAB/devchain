// Centralized UI config for API/WS endpoints

export function getWsBaseUrl(): string {
  // Use same origin - socket.io connects to wherever the page was loaded from
  // Dev: Vite proxies /socket.io to the actual API port
  // Prod: NestJS serves both UI and API on the same port
  return '';
}
