import {
  Controller, Get, Post, Delete, Param, Body, UseGuards,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { AppDataService } from './app-data.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('app')
@UseGuards(AuthGuard)
export class AppDataController {
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
