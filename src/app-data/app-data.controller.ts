import {
  Controller, Get, Post, Patch, Put, Delete, Param, Body, UseGuards,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { AppDataService, UpdateAppUserInput } from './app-data.service';
import { SuperadminGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';

@Controller('app')
@UseGuards(SuperadminGuard)
export class AppDataController {
  private readonly logger = new Logger(AppDataController.name);

  constructor(private readonly appDataService: AppDataService) {}

  @Get('users')
  async getUsers() {
    return this.appDataService.getUsers();
  }

  @Get('users/:id')
  async getUserById(@Param('id') id: string) {
    const user = await this.appDataService.getUserById(id);
    if (!user) {
      throw new HttpException('Usuario no encontrado', HttpStatus.NOT_FOUND);
    }
    return user;
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: UpdateAppUserInput,
    @CurrentUser() admin: AuthUser,
  ) {
    const user = await this.appDataService.updateUser(id, body);
    this.logger.log(
      `Superadmin ${admin.email} edited app user ${id}: ${Object.keys(body ?? {}).join(', ')}`,
    );
    return user;
  }

  @Put('users/:id/password')
  async setPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @CurrentUser() admin: AuthUser,
  ) {
    const result = await this.appDataService.setUserPassword(id, body?.password);
    this.logger.log(`Superadmin ${admin.email} changed password of app user ${id}`);
    return result;
  }

  @Delete('users/:id')
  async deleteUser(@Param('id') id: string) {
    const ok = await this.appDataService.deleteUser(id);
    if (!ok) {
      throw new HttpException('Usuario no encontrado', HttpStatus.NOT_FOUND);
    }
    return { success: true };
  }

  @Post('users/:id/unicas')
  async addUnica(
    @Param('id') id: string,
    @Body() body: { unicaId: string },
  ) {
    if (!body?.unicaId) {
      throw new HttpException('unicaId es requerido', HttpStatus.BAD_REQUEST);
    }
    return this.appDataService.addUserToUnica(id, body.unicaId);
  }

  @Delete('users/:id/unicas/:unicaId')
  async removeUnica(
    @Param('id') id: string,
    @Param('unicaId') unicaId: string,
  ) {
    return this.appDataService.removeUserFromUnica(id, unicaId);
  }

  @Get('unicas')
  async getUnicas() {
    return this.appDataService.getUnicas();
  }

  @Get('unicas/:id')
  async getUnicaById(@Param('id') id: string) {
    const unica = await this.appDataService.getUnicaById(id);
    if (!unica) {
      throw new HttpException('Unica no encontrada', HttpStatus.NOT_FOUND);
    }
    return unica;
  }

  @Get('unicas/:id/assemblies')
  async getAssemblies(@Param('id') id: string) {
    return this.appDataService.getAssemblies(id);
  }

  @Post('unicas/:id/assemblies/:runId/reset')
  async resetAssembly(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ) {
    return this.appDataService.resetAssembly(id, runId);
  }

  @Post('unicas/:id/reset')
  async resetUnica(@Param('id') id: string) {
    return this.appDataService.resetUnica(id);
  }

  @Get('forums/:unicaId')
  async getForumMessages(@Param('unicaId') unicaId: string) {
    return this.appDataService.getForumMessages(unicaId);
  }

  @Get('stats')
  async getStats() {
    return this.appDataService.getOverallStats();
  }
}
