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
  UseGuards,
} from '@nestjs/common';
import { SuperadminGuard } from '../auth/auth.guard';
import {
  BillingCycle,
  SubscriptionStatus,
  SubscriptionsService,
} from './subscriptions.service';

interface UpdatePlanDto {
  name?: string;
  monthlyPrice?: number | null;
  yearlyPrice?: number | null;
  contactOnly?: boolean;
  description?: string | null;
  features?: unknown;
  active?: boolean;
}

interface CreateSubDto {
  planId: string;
  billingCycle: BillingCycle;
  customPrice?: number | null;
  discountPercent?: number;
  discountAmount?: number;
  startsAt: string;
  endsAt?: string;
  notes?: string | null;
}

interface UpdateSubDto {
  planId?: string;
  billingCycle?: BillingCycle;
  customPrice?: number | null;
  discountPercent?: number;
  discountAmount?: number;
  startsAt?: string;
  endsAt?: string;
  status?: SubscriptionStatus;
  notes?: string | null;
}

@Controller()
@UseGuards(SuperadminGuard)
export class SubscriptionsController {
  constructor(private readonly svc: SubscriptionsService) {}

  @Get('plans')
  async listPlans() {
    return this.svc.findAllPlans();
  }

  @Get('plans/:id')
  async getPlan(@Param('id') id: string) {
    const p = await this.svc.findPlan(id);
    if (!p) throw new HttpException('Plan no encontrado', HttpStatus.NOT_FOUND);
    return p;
  }

  @Put('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() body: UpdatePlanDto) {
    const updated = await this.svc.updatePlan(id, body);
    if (!updated) throw new HttpException('Plan no encontrado', HttpStatus.NOT_FOUND);
    return updated;
  }

  @Get('tenants/:tenantId/subscriptions')
  async listTenantSubs(@Param('tenantId') tenantId: string) {
    return this.svc.findSubsByTenant(tenantId);
  }

  @Get('tenants/:tenantId/subscriptions/active')
  async activeSub(@Param('tenantId') tenantId: string) {
    return this.svc.getActiveByTenant(tenantId);
  }

  @Post('tenants/:tenantId/subscriptions')
  async createSub(@Param('tenantId') tenantId: string, @Body() body: CreateSubDto) {
    if (!body.planId || !body.billingCycle || !body.startsAt) {
      throw new HttpException(
        'planId, billingCycle y startsAt son requeridos',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (body.billingCycle !== 'monthly' && body.billingCycle !== 'yearly') {
      throw new HttpException('billingCycle inválido', HttpStatus.BAD_REQUEST);
    }
    return this.svc.createSubscription(tenantId, body);
  }

  @Put('tenants/:tenantId/subscriptions/:id')
  async updateSub(
    @Param('tenantId') _tenantId: string,
    @Param('id') id: string,
    @Body() body: UpdateSubDto,
  ) {
    const updated = await this.svc.updateSubscription(id, body);
    if (!updated) throw new HttpException('Suscripción no encontrada', HttpStatus.NOT_FOUND);
    return updated;
  }

  @Delete('tenants/:tenantId/subscriptions/:id')
  async deleteSub(@Param('tenantId') _tenantId: string, @Param('id') id: string) {
    const ok = await this.svc.deleteSubscription(id);
    if (!ok) throw new HttpException('Suscripción no encontrada', HttpStatus.NOT_FOUND);
    return { message: 'Suscripción eliminada' };
  }
}
