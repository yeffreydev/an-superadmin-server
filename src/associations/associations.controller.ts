import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AssociationsService } from './associations.service';
import { AuthGuard, SuperadminGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';

/**
 * Admin-scoped API: what a creator sees and does with the associations they
 * own. Everything here is filtered by the signed-in account — the full,
 * cross-tenant view lives behind SuperadminGuard in /tenants.
 */
@Controller('associations')
@UseGuards(AuthGuard)
export class AssociationsController {
  constructor(private readonly associations: AssociationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.associations.listForOwner(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: { name: string; code?: string },
  ) {
    return this.associations.create(user.id, body);
  }

  /** Owner of every association, keyed by tenantId (superadmin only). */
  @Get('owners')
  @UseGuards(SuperadminGuard)
  owners() {
    return this.associations.ownersByTenantId();
  }

  @Get('all')
  @UseGuards(SuperadminGuard)
  all() {
    return this.associations.listAll();
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.associations.getOwnedView(user.id, id);
  }

  @Put(':id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { name: string },
  ) {
    return this.associations.rename(user.id, id, body?.name);
  }

  @Get(':id/stats')
  stats(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.associations.stats(user.id, id);
  }

  @Get(':id/users')
  users(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.associations.users(user.id, id);
  }

  @Put(':id/users/:userId')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { dni?: string; password?: string },
  ) {
    return this.associations.updateUserCredentials(user.id, id, userId, body);
  }

  @Get(':id/invitations')
  invitations(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.associations.invitations(user.id, id);
  }

  @Post(':id/invitations')
  createInvitation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { dni: string },
  ) {
    return this.associations.createInvitation(user.id, id, body?.dni);
  }

  @Delete(':id/invitations/:invId')
  deleteInvitation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('invId') invId: string,
  ) {
    return this.associations.deleteInvitation(user.id, id, invId);
  }

  /** Sesión lista para entrar al onboarding (/start) de la asociación. */
  @Post(':id/onboarding-session')
  onboardingSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.associations.onboardingSession(user.id, id);
  }

  @Post(':id/connect-app')
  connectApp(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.associations.connectApp(user.id, id);
  }

  @Get(':id/backup')
  async backup(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { code, sql } = await this.associations.backup(user.id, id);
    const filename = `backup-${code}-${new Date().toISOString().slice(0, 10)}.sql`;
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(sql);
  }
}
