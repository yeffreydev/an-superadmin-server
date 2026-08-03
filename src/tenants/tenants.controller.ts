import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { TenantsService } from './tenants.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('tenants')
@UseGuards(AuthGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  async findAll() {
    return this.tenantsService.findAll();
  }

  @Get('qipi-status')
  async getQipiStatus() {
    return this.tenantsService.getQipiStatus();
  }

  @Post()
  async create(@Body() body: { code: string; name?: string }) {
    if (!body.code) {
      throw new HttpException('code es requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.tenantsService.create(body.code, body.name);
    } catch (error: any) {
      if (error?.code === '23505') {
        throw new HttpException('El tenant ya existe', HttpStatus.CONFLICT);
      }
      throw new HttpException('Error al crear tenant', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { code?: string; name?: string | null; active?: boolean },
  ) {
    const result = await this.tenantsService.update(id, body);
    if (!result) {
      throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
    }
    return result;
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    const deleted = await this.tenantsService.delete(id);
    if (!deleted) {
      throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
    }
    return { message: 'Tenant eliminado correctamente' };
  }

  @Get(':id/backup')
  async getBackup(@Param('id') id: string, @Res() res: Response) {
    const tenant = await this.tenantsService.findById(id);
    if (!tenant) {
      throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
    }
    try {
      const sql = await this.tenantsService.generateBackup(id);
      const filename = `backup-${tenant.code}-${new Date().toISOString().slice(0, 10)}.sql`;
      res.setHeader('Content-Type', 'application/sql');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(sql);
    } catch {
      throw new HttpException(
        'Error al generar la copia de seguridad',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id/users')
  async listUsers(@Param('id') id: string) {
    return this.tenantsService.listUsers(id);
  }

  @Put(':id/users/:userId')
  async updateUserCredentials(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { dni?: string; password?: string },
  ) {
    return this.tenantsService.updateUserCredentials(id, userId, body);
  }

  @Get(':id/invitations')
  async listInvitations(@Param('id') id: string) {
    return this.tenantsService.listInvitations(id);
  }

  @Post(':id/invitations')
  async createInvitation(
    @Param('id') id: string,
    @Body() body: { dni: string },
  ) {
    return this.tenantsService.createInvitation(id, body?.dni);
  }

  @Delete(':id/invitations/:invId')
  async deleteInvitation(
    @Param('id') id: string,
    @Param('invId') invId: string,
  ) {
    const ok = await this.tenantsService.deleteInvitation(id, invId);
    if (!ok) {
      throw new HttpException('Invitación no encontrada', HttpStatus.NOT_FOUND);
    }
    return { success: true };
  }

  @Post(':id/connect-qipi')
  async connectQipi(@Param('id') id: string) {
    return this.tenantsService.connectToQipi(id);
  }

  @Get(':id/stats')
  async getStats(@Param('id') id: string) {
    const tenant = await this.tenantsService.findById(id);
    if (!tenant) {
      throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
    }
    try {
      return await this.tenantsService.getStats(id);
    } catch {
      throw new HttpException(
        'Error al obtener estadísticas del tenant',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
