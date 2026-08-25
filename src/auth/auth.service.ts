import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminRole, AdminUser } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { appConfig } from '../config';
import { GoogleService } from './google.service';
import { JwtPayload, PublicUser } from './auth.types';

export interface AuthResult {
  token: string;
  user: PublicUser;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly google: GoogleService,
  ) {}

  /**
   * Makes sure the account named by SUPERADMIN_EMAIL exists and is flagged as
   * superadmin, so the very first login already works on a fresh database.
   * Any other account that later signs in with that email is promoted too
   * (see resolveRole).
   */
  async onModuleInit() {
    const email = appConfig.SUPERADMIN_EMAIL;
    if (!email) {
      this.logger.warn(
        'SUPERADMIN_EMAIL no está configurado: nadie podrá entrar al área /superadmin',
      );
      return;
    }
    try {
      const existing = await this.prisma.adminUser.findUnique({ where: { email } });
      if (!existing) {
        await this.prisma.adminUser.create({
          data: {
            email,
            name: 'Superadmin',
            role: AdminRole.SUPERADMIN,
            passwordHash: bcrypt.hashSync(appConfig.SUPERADMIN_LOGIN_PASSWORD, 10),
          },
        });
        this.logger.log(`Cuenta superadmin creada para ${email}`);
      } else if (existing.role !== AdminRole.SUPERADMIN || !existing.active) {
        await this.prisma.adminUser.update({
          where: { id: existing.id },
          data: { role: AdminRole.SUPERADMIN, active: true },
        });
      }
    } catch (e: any) {
      // Never block boot on this: the table may not exist yet on a first deploy.
      this.logger.error(`No se pudo preparar la cuenta superadmin: ${e.message}`);
    }
  }

  // --- Registration / login -------------------------------------------------

  async register(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<AuthResult> {
    if (appConfig.SIGNUP_DISABLED) {
      throw new ForbiddenException('El registro está deshabilitado');
    }
    const email = this.normalizeEmail(input.email);
    if (!EMAIL_RE.test(email)) {
      throw new BadRequestException('Correo inválido');
    }
    if (!input.password || input.password.length < 8) {
      throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');
    }

    const existing = await this.prisma.adminUser.findUnique({ where: { email } });
    if (existing) {
      // An account created through Google has no password yet: let its owner
      // set one here instead of dead-ending on "ya existe".
      if (!existing.passwordHash) {
        const updated = await this.prisma.adminUser.update({
          where: { id: existing.id },
          data: {
            passwordHash: bcrypt.hashSync(input.password, 10),
            name: existing.name ?? input.name?.trim() ?? null,
            lastLoginAt: new Date(),
          },
        });
        return this.issue(updated);
      }
      throw new BadRequestException('Ya existe una cuenta con ese correo');
    }

    const user = await this.prisma.adminUser.create({
      data: {
        email,
        name: input.name?.trim() || null,
        passwordHash: bcrypt.hashSync(input.password, 10),
        role: this.resolveRole(email),
        lastLoginAt: new Date(),
      },
    });
    return this.issue(user);
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    if (!bcrypt.compareSync(input.password ?? '', user.passwordHash)) {
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    return this.issue(await this.touch(user));
  }

  /** Signs in (or signs up) with a Google ID token from the browser. */
  async loginWithGoogle(credential: string): Promise<AuthResult> {
    const profile = await this.google.verify(credential);

    const existing = await this.prisma.adminUser.findUnique({
      where: { email: profile.email },
    });

    if (existing) {
      const user = await this.prisma.adminUser.update({
        where: { id: existing.id },
        data: {
          googleId: existing.googleId ?? profile.googleId,
          name: existing.name ?? profile.name,
          avatar: profile.avatar ?? existing.avatar,
          role: this.resolveRole(profile.email, existing.role),
          lastLoginAt: new Date(),
        },
      });
      return this.issue(user);
    }

    if (appConfig.SIGNUP_DISABLED) {
      throw new ForbiddenException('El registro está deshabilitado');
    }
    const user = await this.prisma.adminUser.create({
      data: {
        email: profile.email,
        googleId: profile.googleId,
        name: profile.name,
        avatar: profile.avatar,
        role: this.resolveRole(profile.email),
        lastLoginAt: new Date(),
      },
    });
    return this.issue(user);
  }

  // --- Second key -----------------------------------------------------------

  /**
   * Second factor of the superadmin area: the account already proved who it is
   * (first key / Google), and its email matches SUPERADMIN_EMAIL — this checks
   * the separate SUPERADMIN_PASSWORD and mints a short-lived `sa` token that
   * SuperadminGuard requires.
   */
  async unlockSuperadmin(userId: string, password: string): Promise<{ token: string; expiresIn: string }> {
    const user = await this.prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user || !user.active) {
      throw new UnauthorizedException('Sesión inválida');
    }
    if (user.role !== AdminRole.SUPERADMIN) {
      throw new ForbiddenException('Esta cuenta no tiene acceso al área superadmin');
    }
    if (!password || password !== appConfig.SUPERADMIN_PASSWORD) {
      throw new UnauthorizedException('Clave de superadmin incorrecta');
    }
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sa: true,
    };
    const token = this.jwtService.sign(payload, {
      expiresIn: appConfig.SUPERADMIN_UNLOCK_TTL,
    });
    this.logger.log(`Área superadmin desbloqueada por ${user.email}`);
    return { token, expiresIn: appConfig.SUPERADMIN_UNLOCK_TTL };
  }

  // --- Helpers --------------------------------------------------------------

  async findById(id: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { id } });
  }

  async updateProfile(userId: string, data: { name?: string; password?: string }) {
    const patch: { name?: string; passwordHash?: string } = {};
    if (data.name !== undefined) patch.name = data.name.trim() || undefined;
    if (data.password !== undefined) {
      if (data.password.length < 8) {
        throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');
      }
      patch.passwordHash = bcrypt.hashSync(data.password, 10);
    }
    const user = await this.prisma.adminUser.update({
      where: { id: userId },
      data: patch,
    });
    return this.toPublic(user);
  }

  toPublic(user: AdminUser): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      hasPassword: !!user.passwordHash,
      createdAt: user.createdAt,
    };
  }

  private issue(user: AdminUser): AuthResult {
    if (!user.active) {
      throw new ForbiddenException('Cuenta desactivada');
    }
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return { token: this.jwtService.sign(payload), user: this.toPublic(user) };
  }

  private touch(user: AdminUser): Promise<AdminUser> {
    return this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
  }

  private normalizeEmail(email: string): string {
    return (email ?? '').trim().toLowerCase();
  }

  /** The configured email is always the superadmin; nobody else is promoted. */
  private resolveRole(email: string, current?: AdminRole): AdminRole {
    if (!appConfig.SUPERADMIN_EMAIL) return current ?? AdminRole.ADMIN;
    // Env is the source of truth: matching the email grants the role, and any
    // other account holding it (e.g. after the env changed) loses it.
    return email === appConfig.SUPERADMIN_EMAIL ? AdminRole.SUPERADMIN : AdminRole.ADMIN;
  }
}
