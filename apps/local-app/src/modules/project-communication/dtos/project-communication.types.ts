import type { DeliveryOutcome } from '../../agent-message-delivery/dtos/delivery.types';

export type ProjectCommunicationErrorCode =
  | 'AGENT_CONTEXT_REQUIRED'
  | 'FORBIDDEN_NOT_PROJECT_OWNER'
  | 'CROSS_PROJECT_UNAVAILABLE'
  | 'SOURCE_PROJECT_NOT_FOUND'
  | 'SOURCE_TEMPLATE_NOT_ALLOWED'
  | 'SAME_PROJECT'
  | 'PROJECT_NOT_FOUND'
  | 'AMBIGUOUS_PROJECT'
  | 'TARGET_TEMPLATE_NOT_ALLOWED'
  | 'TARGET_PROJECT_OWNER_NOT_FOUND'
  | 'PROJECT_COMMUNICATION_FAILED'
  | 'DELIVERY_FAILED';

export interface ProjectCommunicationError {
  readonly code: ProjectCommunicationErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export type ProjectCommunicationOutcome<T> =
  | { readonly result: T }
  | { readonly error: ProjectCommunicationError };

export interface ProjectDirectoryEntry {
  readonly id: string;
  readonly shortId: string;
  readonly name: string;
  readonly description: string | null;
  readonly hasProjectOwner: boolean;
}

export interface ProjectDirectoryResult {
  readonly projects: readonly ProjectDirectoryEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ProjectDirectoryOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface SendToProjectInput {
  readonly callerAgentId: string | null | undefined;
  readonly recipientProjectId: string;
  readonly message: string;
}

export interface ProjectDeliveryResult {
  readonly mode: 'project';
  readonly targetProject: {
    readonly id: string;
    readonly shortId: string;
    readonly name: string;
  };
  readonly deliveryStatus: DeliveryOutcome['status'];
  readonly error?: ProjectCommunicationError;
}
