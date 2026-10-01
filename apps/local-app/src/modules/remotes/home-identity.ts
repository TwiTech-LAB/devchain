import { homedir, userInfo } from 'node:os';
import { ValidationError } from '../../common/errors/error-types';
import { HOME_ROOTS, USER_NAME } from './operations/claim.operation';

export interface HomeIdentity {
  user: string;
  homePath: string;
  /** This PC's real account ids; null where the platform has none (Windows). */
  uid: number | null;
  gid: number | null;
}

/**
 * This PC's OS user and home folder — the only identity a claim may use, so
 * stored absolute transcript and project paths stay valid on the VM. The uid
 * travels with the claim so containers running as this PC's uid can write
 * mounted project files on the VM.
 */
export function homeIdentity(): HomeIdentity {
  let user = process.env.USER ?? 'devchain';
  try {
    user = userInfo().username || user;
  } catch {
    // userInfo can fail in a stripped-down runtime; the environment fallback is sufficient.
  }
  return {
    user,
    homePath: homedir(),
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
  };
}

/** Whether a reported home folder is this PC's; null when none was reported. */
export function matchesHomePath(homePath: string | null): boolean | null {
  return homePath === null ? null : homePath === homedir();
}

/**
 * Refuses an identity the claim would reject anyway, before any SSH
 * connection is opened, naming the rule and this PC's value.
 */
export function assertClaimableIdentity(): HomeIdentity {
  const identity = homeIdentity();
  if (!USER_NAME.test(identity.user)) {
    throw new ValidationError(
      `This PC's user name "${identity.user}" cannot claim a VM: it must start with a lowercase letter or underscore and use lowercase letters, digits, - or _, with at most 32 characters.`,
      { reason: 'claim_user_name_invalid' },
    );
  }
  if (!HOME_ROOTS.some((root) => identity.homePath.startsWith(root))) {
    throw new ValidationError(
      `This PC's home folder "${identity.homePath}" cannot claim a VM: it must be under ${HOME_ROOTS.join(', ')}.`,
      { reason: 'claim_home_path_invalid' },
    );
  }
  return identity;
}

/** Operation kinds whose details carry a claim identity. */
export const CLAIM_IDENTITY_KINDS = [
  'claim',
  'create_vm',
  'reset_vm',
  'install_host',
  'update_logins',
] as const;

/**
 * The refusal message when a claim-capable operation's persisted user or home
 * differs from this PC's identity, or null when it may continue: partly applied
 * claims are never re-targeted to another identity. Operations without a
 * recorded identity compare as matching (nothing was applied under a different
 * identity).
 */
export function claimIdentityMismatch(
  kind: string,
  details: Record<string, unknown>,
): string | null {
  if (!(CLAIM_IDENTITY_KINDS as readonly string[]).includes(kind)) return null;
  const persistedUser = typeof details.userName === 'string' ? details.userName : null;
  const persistedHome = typeof details.homePath === 'string' ? details.homePath : null;
  if (!persistedUser || !persistedHome) return null;
  const identity = homeIdentity();
  if (persistedUser === identity.user && persistedHome === identity.homePath) return null;
  return (
    `This operation claims the VM as "${persistedUser}" with home "${persistedHome}", ` +
    `but this PC is "${identity.user}" with home "${identity.homePath}". ` +
    'The VM identity is locked to this PC; cancel this operation and start a new one.'
  );
}
