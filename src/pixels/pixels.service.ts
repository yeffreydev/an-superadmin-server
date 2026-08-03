import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PixelMode } from '@prisma/client';

@Injectable()
export class PixelsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(mode?: PixelMode) {
    return this.prisma.pixel.findMany({
      where: mode ? { mode } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { events: true } } },
    });
  }

  async create(name: string, mode: PixelMode = PixelMode.DEV) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return this.prisma.pixel.create({
      data: { name, slug, mode },
    });
  }

  async delete(id: string) {
    return this.prisma.pixel.delete({ where: { id } });
  }

  async track(slug: string, ip: string, userAgent: string, referer: string) {
    const pixel = await this.prisma.pixel.findUnique({ where: { slug } });
    if (!pixel) return null;

    await this.prisma.$transaction([
      this.prisma.pixel.update({
        where: { id: pixel.id },
        data: { views: { increment: 1 } },
      }),
      this.prisma.pixelEvent.create({
        data: {
          pixelId: pixel.id,
          ip: ip || null,
          userAgent: userAgent || null,
          referer: referer || null,
        },
      }),
    ]);

    return true;
  }

  async getStats(id: string) {
    const pixel = await this.prisma.pixel.findUnique({
      where: { id },
      include: {
        events: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        _count: { select: { events: true } },
      },
    });
    return pixel;
  }

  async getTotalStats() {
    const [totalPixels, totalViews] = await Promise.all([
      this.prisma.pixel.count(),
      this.prisma.pixel.aggregate({ _sum: { views: true } }),
    ]);
    return {
      totalPixels,
      totalViews: totalViews._sum.views || 0,
    };
  }
}
