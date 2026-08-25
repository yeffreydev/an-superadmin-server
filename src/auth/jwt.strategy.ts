import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { appConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, JwtPayload } from './auth.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: appConfig.JWT_SECRET,
    });
  }

  /**
   * Resolves the account on every request instead of trusting the token body,
   * so a deactivated account or a role change takes effect immediately rather
   * than at token expiry.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = payload?.sub
      ? await this.prisma.adminUser.findUnique({ where: { id: payload.sub } })
      : null;
    if (!user || !user.active) {
      throw new UnauthorizedException('Sesión inválida');
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      superadminUnlocked: payload.sa === true,
    };
  }
}
