import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { TenantsModule } from '../tenants/tenants.module';
import { AppDataModule } from '../app-data/app-data.module';
import { PixelsModule } from '../pixels/pixels.module';

@Module({
  imports: [TenantsModule, AppDataModule, PixelsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
