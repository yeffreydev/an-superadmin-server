import { All, Body, Controller, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { SuperadminGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { FinanceService } from './finance.service';

/**
 * Income/expense module of an association, operated from the superadmin area:
 * `/finance/:tenantId/<unicas API path>` (see FinanceService for the list of
 * operations that are let through).
 */
@Controller('finance/:tenantId')
@UseGuards(SuperadminGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @All('*')
  async forward(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    const prefix = `/finance/${tenantId}/`;
    const path = decodeURIComponent(req.path).slice(prefix.length);
    const result = await this.finance.forward(
      tenantId,
      req.method,
      path,
      query,
      body,
      user?.email ?? 'superadmin',
    );
    res.status(result.status).json(result.data ?? null);
  }
}
