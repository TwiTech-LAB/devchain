export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email?: string;
  expiresAt: string;
}

export interface CloudConnectionStatus {
  connected: boolean;
  userId?: string;
  email?: string;
  expiresAt?: string;
  identityServiceUrl: string;
}
