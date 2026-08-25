import { AdminRole } from '@prisma/client';

/** Payload signed into every panel JWT. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: AdminRole;
  /** true only on tokens minted by the second-key unlock at /superadmin. */
  sa?: boolean;
}

/** What guards attach to `request.user`. */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: AdminRole;
  /** Whether this request carries an unlocked superadmin token. */
  superadminUnlocked: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: AdminRole;
  hasPassword: boolean;
  createdAt: Date;
}
