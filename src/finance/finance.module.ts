import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [TenantsModule],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
