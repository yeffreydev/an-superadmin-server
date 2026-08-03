import { Injectable } from '@nestjs/common';
import { TenantsService } from '../tenants/tenants.service';
import { AppDataService } from '../app-data/app-data.service';
import { PixelsService } from '../pixels/pixels.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly appDataService: AppDataService,
    private readonly pixelsService: PixelsService,
  ) {}

  async getDashboard() {
    const [totalTenants, appStats, pixelStats] = await Promise.all([
      this.tenantsService.getTotalCount(),
      this.appDataService.getOverallStats(),
      this.pixelsService.getTotalStats(),
    ]);

    return {
      totalTenants,
      totalAppUsers: appStats.totalUsers,
      totalUnicas: appStats.totalUnicas,
      totalForumMessages: appStats.totalForumMessages,
      totalPixels: pixelStats.totalPixels,
      totalPixelViews: pixelStats.totalViews,
    };
  }
}
