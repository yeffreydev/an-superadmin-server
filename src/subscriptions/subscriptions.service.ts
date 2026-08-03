import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { appConfig } from '../config';

export type BillingCycle = 'monthly' | 'yearly';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export interface PlanRow {
  id: string;
  key: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  contactOnly: boolean;
  description: string | null;
  features: unknown;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRow {
  id: string;
  tenantId: string;
  planId: string;
  billingCycle: BillingCycle;
  customPrice: string | null;
  discountPercent: string;
  discountAmount: string;
  startsAt: string;
  endsAt: string;
  status: SubscriptionStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_PLANS = [
  {
    key: 'basico',
    name: 'Básico',
    monthlyPrice: 39.9,
    yearlyPrice: 39.9 * 12,
    contactOnly: false,
    description: 'Plan inicial para cooperativas pequeñas',
    features: ['Hasta 100 usuarios', 'Soporte por email'],
  },
  {
    key: 'pro',
    name: 'Pro',
    monthlyPrice: 99.9,
    yearlyPrice: 99.9 * 12,
    contactOnly: false,
    description: 'Plan profesional con funciones avanzadas',
    features: ['Usuarios ilimitados', 'Soporte prioritario', 'Reportes avanzados'],
  },
  {
    key: 'empresarial',
    name: 'Empresarial',
    monthlyPrice: null,
    yearlyPrice: null,
    contactOnly: true,
    description: 'Plan empresarial personalizado - contáctanos',
    features: ['Personalización completa', 'SLA dedicado', 'Soporte 24/7'],
  },
];

@Injectable()
export class SubscriptionsService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  async onModuleInit() {
    this.pool = new Pool({ connectionString: appConfig.ACAS_DATABASE_URL });
    await this.bootstrap();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  private async bootstrap() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        monthly_price NUMERIC(10,2),
        yearly_price NUMERIC(10,2),
        contact_only BOOLEAN NOT NULL DEFAULT FALSE,
        description TEXT,
        features JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        plan_id UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
        billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
        custom_price NUMERIC(10,2),
        discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
        starts_at TIMESTAMP NOT NULL,
        ends_at TIMESTAMP NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_tenant_subs_tenant ON tenant_subscriptions(tenant_id);`,
    );

    for (const p of DEFAULT_PLANS) {
      await this.pool.query(
        `INSERT INTO subscription_plans (key, name, monthly_price, yearly_price, contact_only, description, features)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [
          p.key,
          p.name,
          p.monthlyPrice,
          p.yearlyPrice,
          p.contactOnly,
          p.description,
          JSON.stringify(p.features),
        ],
      );
    }
  }

  private mapPlan(row: any): PlanRow {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      monthlyPrice: row.monthly_price,
      yearlyPrice: row.yearly_price,
      contactOnly: row.contact_only,
      description: row.description,
      features: row.features,
      active: row.active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSub(row: any): SubscriptionRow {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      planId: row.plan_id,
      billingCycle: row.billing_cycle,
      customPrice: row.custom_price,
      discountPercent: row.discount_percent,
      discountAmount: row.discount_amount,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findAllPlans(): Promise<PlanRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM subscription_plans ORDER BY contact_only ASC, monthly_price ASC NULLS LAST`,
    );
    return r.rows.map((row) => this.mapPlan(row));
  }

  async findPlan(id: string): Promise<PlanRow | null> {
    const r = await this.pool.query(`SELECT * FROM subscription_plans WHERE id = $1`, [id]);
    if (r.rowCount === 0) return null;
    return this.mapPlan(r.rows[0]);
  }

  async updatePlan(
    id: string,
    data: {
      name?: string;
      monthlyPrice?: number | null;
      yearlyPrice?: number | null;
      contactOnly?: boolean;
      description?: string | null;
      features?: unknown;
      active?: boolean;
    },
  ): Promise<PlanRow | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (data.name !== undefined) { fields.push(`name = $${i++}`); values.push(data.name); }
    if (data.monthlyPrice !== undefined) { fields.push(`monthly_price = $${i++}`); values.push(data.monthlyPrice); }
    if (data.yearlyPrice !== undefined) { fields.push(`yearly_price = $${i++}`); values.push(data.yearlyPrice); }
    if (data.contactOnly !== undefined) { fields.push(`contact_only = $${i++}`); values.push(data.contactOnly); }
    if (data.description !== undefined) { fields.push(`description = $${i++}`); values.push(data.description); }
    if (data.features !== undefined) { fields.push(`features = $${i++}::jsonb`); values.push(JSON.stringify(data.features)); }
    if (data.active !== undefined) { fields.push(`active = $${i++}`); values.push(data.active); }
    if (fields.length === 0) return this.findPlan(id);
    fields.push(`updated_at = NOW()`);
    values.push(id);
    const r = await this.pool.query(
      `UPDATE subscription_plans SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    if (r.rowCount === 0) return null;
    return this.mapPlan(r.rows[0]);
  }

  async findSubsByTenant(tenantId: string): Promise<Array<SubscriptionRow & { plan: PlanRow }>> {
    const r = await this.pool.query(
      `SELECT s.*, p.id AS p_id, p.key AS p_key, p.name AS p_name,
              p.monthly_price AS p_monthly_price, p.yearly_price AS p_yearly_price,
              p.contact_only AS p_contact_only, p.description AS p_description,
              p.features AS p_features, p.active AS p_active,
              p.created_at AS p_created_at, p.updated_at AS p_updated_at
       FROM tenant_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1
       ORDER BY s.starts_at DESC`,
      [tenantId],
    );
    return r.rows.map((row) => ({
      ...this.mapSub(row),
      plan: {
        id: row.p_id,
        key: row.p_key,
        name: row.p_name,
        monthlyPrice: row.p_monthly_price,
        yearlyPrice: row.p_yearly_price,
        contactOnly: row.p_contact_only,
        description: row.p_description,
        features: row.p_features,
        active: row.p_active,
        createdAt: row.p_created_at,
        updatedAt: row.p_updated_at,
      },
    }));
  }

  async createSubscription(
    tenantId: string,
    data: {
      planId: string;
      billingCycle: BillingCycle;
      customPrice?: number | null;
      discountPercent?: number;
      discountAmount?: number;
      startsAt: string;
      endsAt?: string;
      notes?: string | null;
    },
  ): Promise<SubscriptionRow> {
    let endsAt = data.endsAt;
    if (!endsAt) {
      const start = new Date(data.startsAt);
      const end = new Date(start);
      if (data.billingCycle === 'yearly') end.setFullYear(end.getFullYear() + 1);
      else end.setMonth(end.getMonth() + 1);
      endsAt = end.toISOString();
    }

    const r = await this.pool.query(
      `INSERT INTO tenant_subscriptions
        (tenant_id, plan_id, billing_cycle, custom_price, discount_percent, discount_amount, starts_at, ends_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        tenantId,
        data.planId,
        data.billingCycle,
        data.customPrice ?? null,
        data.discountPercent ?? 0,
        data.discountAmount ?? 0,
        data.startsAt,
        endsAt,
        data.notes ?? null,
      ],
    );
    return this.mapSub(r.rows[0]);
  }

  async updateSubscription(
    id: string,
    data: {
      planId?: string;
      billingCycle?: BillingCycle;
      customPrice?: number | null;
      discountPercent?: number;
      discountAmount?: number;
      startsAt?: string;
      endsAt?: string;
      status?: SubscriptionStatus;
      notes?: string | null;
    },
  ): Promise<SubscriptionRow | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (data.planId !== undefined) { fields.push(`plan_id = $${i++}`); values.push(data.planId); }
    if (data.billingCycle !== undefined) { fields.push(`billing_cycle = $${i++}`); values.push(data.billingCycle); }
    if (data.customPrice !== undefined) { fields.push(`custom_price = $${i++}`); values.push(data.customPrice); }
    if (data.discountPercent !== undefined) { fields.push(`discount_percent = $${i++}`); values.push(data.discountPercent); }
    if (data.discountAmount !== undefined) { fields.push(`discount_amount = $${i++}`); values.push(data.discountAmount); }
    if (data.startsAt !== undefined) { fields.push(`starts_at = $${i++}`); values.push(data.startsAt); }
    if (data.endsAt !== undefined) { fields.push(`ends_at = $${i++}`); values.push(data.endsAt); }
    if (data.status !== undefined) { fields.push(`status = $${i++}`); values.push(data.status); }
    if (data.notes !== undefined) { fields.push(`notes = $${i++}`); values.push(data.notes); }
    if (fields.length === 0) {
      const r = await this.pool.query(`SELECT * FROM tenant_subscriptions WHERE id = $1`, [id]);
      if (r.rowCount === 0) return null;
      return this.mapSub(r.rows[0]);
    }
    fields.push(`updated_at = NOW()`);
    values.push(id);
    const r = await this.pool.query(
      `UPDATE tenant_subscriptions SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    if (r.rowCount === 0) return null;
    return this.mapSub(r.rows[0]);
  }

  async deleteSubscription(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM tenant_subscriptions WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async getActiveByTenant(tenantId: string): Promise<(SubscriptionRow & { plan: PlanRow }) | null> {
    const subs = await this.findSubsByTenant(tenantId);
    const now = Date.now();
    return (
      subs.find(
        (s) => s.status === 'active' && new Date(s.startsAt).getTime() <= now && new Date(s.endsAt).getTime() >= now,
      ) ?? null
    );
  }
}
