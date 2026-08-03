import {
  Controller, Get, Post, Delete,
  Param, Body, Query, Req, Res, UseGuards,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PixelsService } from './pixels.service';
import { AuthGuard } from '../auth/auth.guard';
import { PixelMode } from '@prisma/client';

// 1x1 transparent GIF
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

@Controller('pixels')
export class PixelsController {
  constructor(private readonly pixelsService: PixelsService) {}

  @Get()
  @UseGuards(AuthGuard)
  async findAll(@Query('mode') mode?: string) {
    const pixelMode = mode === 'PRODUCTION' ? PixelMode.PRODUCTION : mode === 'DEV' ? PixelMode.DEV : undefined;
    return this.pixelsService.findAll(pixelMode);
  }

  @Post()
  @UseGuards(AuthGuard)
  async create(@Body() body: { name: string; mode?: string }) {
    if (!body.name) {
      throw new HttpException('name es requerido', HttpStatus.BAD_REQUEST);
    }
    const pixelMode = body.mode === 'PRODUCTION' ? PixelMode.PRODUCTION : PixelMode.DEV;
    try {
      return await this.pixelsService.create(body.name, pixelMode);
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new HttpException('El slug ya existe', HttpStatus.CONFLICT);
      }
      throw error;
    }
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async delete(@Param('id') id: string) {
    try {
      await this.pixelsService.delete(id);
      return { message: 'Pixel eliminado' };
    } catch {
      throw new HttpException('Pixel no encontrado', HttpStatus.NOT_FOUND);
    }
  }

  @Get(':slug/track')
  async track(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    const referer = req.headers['referer'] || '';

    await this.pixelsService.track(slug, ip, userAgent, referer);

    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': TRANSPARENT_GIF.length.toString(),
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(TRANSPARENT_GIF);
  }

  @Get(':id/stats')
  @UseGuards(AuthGuard)
  async getStats(@Param('id') id: string) {
    const stats = await this.pixelsService.getStats(id);
    if (!stats) {
      throw new HttpException('Pixel no encontrado', HttpStatus.NOT_FOUND);
    }
    return stats;
  }
}
