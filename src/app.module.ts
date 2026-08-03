import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { PixelsModule } from './pixels/pixels.module';
import { AppDataModule } from './app-data/app-data.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AgentModule } from './agent/agent.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ClientsModule } from './clients/clients.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    TenantsModule,
    PixelsModule,
    AppDataModule,
    DashboardModule,
    AgentModule,
    SubscriptionsModule,
    ClientsModule,
  ],
})
export class AppModule {}
