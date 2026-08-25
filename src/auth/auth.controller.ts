import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthUser } from './auth.types';
import { appConfig } from '../config';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** What the login screen needs to render itself (Google button, signups). */
  @Get('config')
  config() {
    return {
      googleClientId: appConfig.GOOGLE_CLIENT_ID || null,
      signupEnabled: !appConfig.SIGNUP_DISABLED,
      // Base domain new associations get a subdomain of.
      associationDomain: appConfig.ASSOCIATION_DOMAIN,
    };
  }

  @Post('register')
  register(@Body() body: { email: string; password: string; name?: string }) {
    return this.authService.register(body);
  }

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body);
  }

  @Post('google')
  google(@Body() body: { credential: string }) {
    return this.authService.loginWithGoogle(body?.credential);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const full = await this.authService.findById(user.id);
    return {
      user: full ? this.authService.toPublic(full) : null,
      superadminUnlocked: user.superadminUnlocked,
      // Whether this account may even try the second key.
      canUnlockSuperadmin: user.role === AdminRole.SUPERADMIN,
    };
  }

  @Put('me')
  @UseGuards(AuthGuard)
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body() body: { name?: string; password?: string },
  ) {
    return this.authService.updateProfile(user.id, body);
  }

  /** Second key of the superadmin area (asked at /superadmin). */
  @Post('superadmin/unlock')
  @UseGuards(AuthGuard)
  unlock(@CurrentUser() user: AuthUser, @Body() body: { password: string }) {
    return this.authService.unlockSuperadmin(user.id, body?.password);
  }
}
