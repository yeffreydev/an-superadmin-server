import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport';
import { AdminRole } from '@prisma/client';
import { AuthUser } from './auth.types';

/** Any signed-in panel account (admin or superadmin). */
@Injectable()
export class AuthGuard extends PassportAuthGuard('jwt') {}

/**
 * The superadmin area. Requires both keys: a valid session *and* a token minted
 * by POST /auth/superadmin/unlock (the second password asked at /superadmin).
 */
@Injectable()
export class SuperadminGuard extends PassportAuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user || user.role !== AdminRole.SUPERADMIN) {
      throw new ForbiddenException('Requiere permisos de superadmin');
    }
    if (!user.superadminUnlocked) {
      // Distinct message so the frontend can send the user back to the second
      // password screen instead of logging them out entirely.
      throw new ForbiddenException('SUPERADMIN_LOCKED');
    }
    return true;
  }
}
