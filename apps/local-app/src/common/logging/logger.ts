import pino from 'pino';
import { getEnvConfig } from '../config/env.config';

const config = getEnvConfig();

// Detect if running as MCP stdio server (logs would interfere with JSON-RPC)
const isMcpStdio =
  process.argv.some((arg) => arg.includes('mcp-server')) || process.env.MCP_STDIO === 'true';
const isTest = config.NODE_ENV === 'test' || typeof process.env.JEST_WORKER_ID === 'string';

// Always write logs to stderr (fd 2) to avoid interfering with stdout
// This is critical for stdio-based tools like MCP servers
export const logger = pino(
  {
    // Use 'silent' level for MCP stdio servers to avoid stderr noise
    level: isMcpStdio || isTest ? 'silent' : config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development' && !isMcpStdio && !isTest
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
              destination: 2, // stderr
            },
          }
        : undefined,
  },
  pino.destination({ dest: 2, sync: isTest }), // fd 2 = stderr
);

export function createLogger(context: string) {
  return logger.child({ context });
}
