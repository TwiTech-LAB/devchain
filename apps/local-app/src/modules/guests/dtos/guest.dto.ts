/**
 * DTO for guest registration request
 */
export interface RegisterGuestDto {
  /**
   * Display name for the guest agent
   */
  name: string;

  /**
   * The tmux session ID where the guest is running
   */
  tmuxSessionId: string;

  /**
   * Optional description of the guest's purpose
   */
  description?: string;
}

/**
 * DTO for guest registration response
 */
export interface RegisterGuestResultDto {
  /**
   * The guest ID (used as sessionId for MCP tools)
   */
  guestId: string;

  /**
   * The project the guest was assigned to
   */
  projectId: string;

  /**
   * The project name
   */
  projectName: string;

  /**
   * Whether this is the sandbox project (no matching project found)
   */
  isSandbox: boolean;
}

/**
 * DTO for guest details
 */
export interface GuestDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  tmuxSessionId: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}
