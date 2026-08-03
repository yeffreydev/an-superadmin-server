import {
  Injectable, OnModuleInit, OnModuleDestroy, Logger,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import * as bcrypt from 'bcryptjs';
import axios from 'axios';
import { appConfig } from '../config';

// Baseline catalog seeded into every new tenant. Mirrors server/prisma/seed.ts
// so a freshly created unica is usable (login + catalogs) from minute one.
const ROLES = ['User', 'Admin', 'Moderator', 'Partner'];
const LOAN_TYPES = ['FIXED', 'VARIABLE', 'REBATE', 'MATURITY'];
const SOCIAL_FUNDS_TYPES = ['LEGAL', 'SOCIAL'];
const SCHEDULE_TYPES = ['ASSEMBLY'];
const SCHEDULE_FREQUENCY_TYPES = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'];
const ADMIN_DNI = '12345678';
const ADMIN_PASSWORD = '12345678';
const ADMIN_EMAIL = 'admin@aquinace.com';

export interface TenantRow {
  id: string;
  code: string;
  name: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Shape returned by qipi-server-nest's POST /unicas/register. */
export interface QipiUnica {
  id: string;
  tenantId: string;
  name: string;
  serverUrl: string;
  description: string | null;
  avatar: string | null;
  active: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries an async op with backoff. Used for registerWithQipi: qipi-server-nest
 * can be cold-starting or briefly unreachable, and a single 8s attempt was the
 * root cause of tenants created without their invitations reaching the app.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delaysMs: number[],
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await sleep(delaysMs[i] ?? delaysMs[delaysMs.length - 1]);
    }
  }
  throw lastError;
}

@Injectable()
export class TenantsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantsService.name);
  private pool: Pool;

  onModuleInit() {
    this.pool = new Pool({ connectionString: appConfig.ACAS_DATABASE_URL });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async findAll(): Promise<TenantRow[]> {
    const r = await this.pool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants
         ORDER BY "createdAt" DESC`,
    );
    return r.rows;
  }

  async findById(id: string): Promise<TenantRow | null> {
    const r = await this.pool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async findByCode(code: string): Promise<TenantRow | null> {
    const r = await this.pool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants WHERE code = $1`,
      [code],
    );
    return r.rows[0] ?? null;
  }

  async create(
    code: string,
    name?: string,
  ): Promise<TenantRow & { qipiConnected: boolean; qipiError?: string }> {
    const client = await this.pool.connect();
    let tenant: TenantRow;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO tenants (id, code, name, active, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, true, NOW(), NOW())
         RETURNING id, code, name, active, "createdAt", "updatedAt"`,
        [code, name ?? null],
      );
      tenant = r.rows[0];
      await this.seedTenant(client, tenant.id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Register this tenant as a "Unica" in qipi-server-nest so app
    // invitations can reach it. Awaited with retries (qipi may be
    // cold-starting) instead of fire-and-forget, so creation only reports
    // success once invitations are actually able to arrive. If it still
    // fails after retries, the tenant stays created (seeded data isn't
    // lost) but the caller is told so the admin can retry via connectToQipi
    // instead of finding out later that invitations silently never landed.
    try {
      await withRetry(() => this.registerWithQipi(tenant), 4, [1000, 3000, 7000, 15000]);
      return { ...tenant, qipiConnected: true };
    } catch (e: any) {
      const msg = e?.response?.data?.message || e.message || 'Error desconocido';
      this.logger.error(
        `Auto-connect to qipi failed for tenant "${tenant.code}" after retries: ${msg}`,
      );
      return { ...tenant, qipiConnected: false, qipiError: msg };
    }
  }

  /**
   * Registers/updates this tenant as a "Unica" in qipi-server-nest via its
   * public POST /unicas/register endpoint, so its invitations (AppInvitation
   * rows) become visible to the app through check-invitations.
   *
   * The QIPI side keys a Unica by tenantId, which superadmin-server treats
   * as the ACAS tenant *code* everywhere else (see app-data.service.ts) — so
   * the code, not the tenant UUID, is what gets sent here.
   */
  private async registerWithQipi(tenant: TenantRow): Promise<QipiUnica> {
    const res = await axios.post<QipiUnica>(
      `${appConfig.QIPI_SERVER_URL}/unicas/register`,
      {
        tenantId: tenant.code,
        name: tenant.name || tenant.code,
        description: tenant.name ?? undefined,
      },
      { timeout: 20000 },
    );
    return res.data;
  }

  /**
   * Connection health of every tenant against qipi-server-nest, in one call.
   * Fetches GET /unicas/all once and diffs it against local tenant codes,
   * instead of one round-trip per tenant. `null` means qipi itself could not
   * be reached, so health is unknown (not "disconnected") for every tenant.
   */
  async getQipiStatus(): Promise<Record<string, boolean | null>> {
    const tenants = await this.findAll();
    const status: Record<string, boolean | null> = {};
    try {
      const res = await axios.get<QipiUnica[]>(
        `${appConfig.QIPI_SERVER_URL}/unicas/all`,
        { timeout: 8000 },
      );
      const connectedCodes = new Set(res.data.map((u) => u.tenantId));
      for (const t of tenants) status[t.id] = connectedCodes.has(t.code);
    } catch (e: any) {
      this.logger.warn(`Failed to fetch qipi status: ${e.message}`);
      for (const t of tenants) status[t.id] = null;
    }
    return status;
  }

  /**
   * Manually (re)connects a tenant to qipi-server-nest. Used from the
   * superadmin UI to fix tenants that were created before this connection
   * existed, or whose auto-connect failed (qipi down at creation time).
   */
  async connectToQipi(id: string): Promise<{ success: true; unica: QipiUnica }> {
    const tenant = await this.findById(id);
    if (!tenant) {
      throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
    }
    try {
      const unica = await this.registerWithQipi(tenant);
      return { success: true, unica };
    } catch (e: any) {
      const msg = e?.response?.data?.message || e.message || 'Error desconocido';
      throw new HttpException(
        `No se pudo conectar con la app (qipi): ${msg}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Seeds the minimum baseline so a new unica is operational:
   * roles, an Admin user (login by dni), bank identity, a stock, and the
   * loan / social-fund / schedule catalogs. Every row stamped with tenantId.
   * Runs inside the create() transaction — any failure rolls back the tenant.
   */
  private async seedTenant(client: PoolClient, tenantId: string): Promise<void> {
    // Roles
    const roleIds: Record<string, string> = {};
    for (const role of ROLES) {
      const res = await client.query(
        `INSERT INTO "Role" (id, "tenantId", name)
         VALUES (gen_random_uuid()::text, $1, $2)
         RETURNING id`,
        [tenantId, role],
      );
      roleIds[role] = res.rows[0].id;
    }

    // Admin user (login: dni + password, scoped by tenantId)
    const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await client.query(
      `INSERT INTO "User"
         (id, "tenantId", name, lastname, dni, email, phone, password, "roleId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Admin', 'User', $2, $3, '1234567890', $4, $5, NOW(), NOW())`,
      [tenantId, ADMIN_DNI, ADMIN_EMAIL, passwordHash, roleIds['Admin']],
    );

    // Bank identity (defaults handled by DB) + initial stock
    const bankRes = await client.query(
      `INSERT INTO "BankIdentity" (id, "tenantId", name, avatar, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Nueva Banca', 'https://res.cloudinary.com/dk5b3', NOW(), NOW())
       RETURNING id`,
      [tenantId],
    );
    const bankIdentityId = bankRes.rows[0].id;
    await client.query(
      `INSERT INTO "Stock"
         (id, "tenantId", name, price, available, total, "bankIdentityId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Stock 1', 10, -1, -1, $2, NOW(), NOW())`,
      [tenantId, bankIdentityId],
    );

    // Catalogs
    for (const t of LOAN_TYPES) {
      await client.query(
        `INSERT INTO "LoanType" (id, "tenantId", name)
         VALUES (gen_random_uuid()::text, $1, $2)`,
        [tenantId, t],
      );
    }
    for (const t of SOCIAL_FUNDS_TYPES) {
      await client.query(
        `INSERT INTO "SocialFundsType" (id, "tenantId", name, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())`,
        [tenantId, t],
      );
    }
    for (const c of SCHEDULE_TYPES) {
      await client.query(
        `INSERT INTO "ScheduleType" (id, "tenantId", code)
         VALUES (gen_random_uuid()::text, $1, $2)`,
        [tenantId, c],
      );
    }
    for (const f of SCHEDULE_FREQUENCY_TYPES) {
      await client.query(
        `INSERT INTO "ScheduleFrequencyTypes" (id, "tenantId", type, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())`,
        [tenantId, f],
      );
    }
  }

  async update(
    id: string,
    data: { code?: string; name?: string | null; active?: boolean },
  ): Promise<TenantRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (data.code !== undefined) {
      fields.push(`code = $${i++}`);
      values.push(data.code);
    }
    if (data.name !== undefined) {
      fields.push(`name = $${i++}`);
      values.push(data.name);
    }
    if (data.active !== undefined) {
      fields.push(`active = $${i++}`);
      values.push(data.active);
    }
    if (fields.length === 0) return this.findById(id);
    fields.push(`"updatedAt" = NOW()`);
    values.push(id);
    const r = await this.pool.query(
      `UPDATE tenants SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, code, name, active, "createdAt", "updatedAt"`,
      values,
    );
    const tenant: TenantRow | null = r.rows[0] ?? null;

    // Reactivating a tenant re-registers it with qipi too (mirrors create()).
    if (tenant && data.active === true) {
      withRetry(() => this.registerWithQipi(tenant), 4, [1000, 3000, 7000, 15000]).catch(
        (e: any) => {
          const msg = e?.response?.data?.message || e.message || 'Error desconocido';
          this.logger.error(`Reconnect to qipi failed for tenant "${tenant.code}": ${msg}`);
        },
      );
    }

    return tenant;
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async getStats(tenantId: string) {
    const [usersRes, loansRes, activeLoansRes, depositsRes, partnersRes, bankRes] =
      await Promise.all([
        this.pool.query(
          `SELECT COUNT(*) as count FROM "User" WHERE "tenantId" = $1`,
          [tenantId],
        ),
        this.pool.query(
          `SELECT COUNT(*) as count FROM "Loan" WHERE "tenantId" = $1`,
          [tenantId],
        ),
        this.pool.query(
          `SELECT COUNT(*) as count FROM "Loan" WHERE "tenantId" = $1 AND status = 'active'`,
          [tenantId],
        ),
        this.pool.query(
          `SELECT COUNT(*) as count FROM "Deposits" WHERE "tenantId" = $1`,
          [tenantId],
        ),
        this.pool.query(
          `SELECT COUNT(*) as count FROM "User" u
             JOIN "Role" r ON u."roleId" = r.id
             WHERE u."tenantId" = $1 AND r.name = 'Partner'`,
          [tenantId],
        ),
        this.pool.query(
          `SELECT name FROM "BankIdentity" WHERE "tenantId" = $1 LIMIT 1`,
          [tenantId],
        ),
      ]);

    return {
      totalUsers: parseInt(usersRes.rows[0].count),
      totalPartners: parseInt(partnersRes.rows[0].count),
      totalLoans: parseInt(loansRes.rows[0].count),
      activeLoans: parseInt(activeLoansRes.rows[0].count),
      totalDeposits: parseInt(depositsRes.rows[0].count),
      bankName: bankRes.rows[0]?.name || 'Sin configurar',
    };
  }

  /** SQL export of a single tenant: just the rows owned by its tenantId. */
  async generateBackup(tenantId: string): Promise<string> {
    const tables = [
      'Role', 'BankIdentity', 'LoanType', 'SocialFundsType',
      'ScheduleFrequencyTypes', 'ScheduleFrequency', 'ScheduleType', 'Form', 'Field',
      'User', 'Stock', 'Schedule', 'ScheduleRun', 'ScheduleAgenda', 'ScheduleParticipant',
      'Loan', 'LoanInstallment', 'LoanPayment', 'UserStock',
      'SocialFundsIncomes', 'SocialFundsExpenses', 'Withdrawals', 'DepositorPayouts',
      'AdministrativeExpenses', 'Dividends', 'OtherExpenses', 'OtherIncomes',
      'Deposits', 'FormSubmission', 'FieldValue', 'Acta',
      'CreditApplication', 'AppInvitation',
    ];
    const parts: string[] = [
      `-- Single-tenant backup`,
      `-- tenantId: ${tenantId}`,
      `-- generated: ${new Date().toISOString()}`,
      ``,
    ];
    for (const t of tables) {
      const cols = await this.pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1
          ORDER BY ordinal_position`,
        [t],
      );
      if (cols.rowCount === 0) continue;
      const colNames = cols.rows.map((r) => r.column_name as string);
      const r = await this.pool.query(
        `SELECT row_to_json(x) AS row FROM "${t}" x WHERE x."tenantId" = $1`,
        [tenantId],
      );
      if (r.rowCount === 0) continue;
      parts.push(`-- ${t}: ${r.rowCount} rows`);
      for (const { row } of r.rows) {
        const values = colNames.map((c) => sqlLiteral(row[c]));
        parts.push(
          `INSERT INTO "${t}" (${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`,
        );
      }
      parts.push('');
    }
    return parts.join('\n');
  }

  async listUsers(tenantId: string) {
    const r = await this.pool.query(
      `SELECT u.id, u.name, u.lastname, u.dni, u.email, u.phone,
              u."createdAt", r.name AS role
         FROM "User" u
         LEFT JOIN "Role" r ON r.id = u."roleId"
        WHERE u."tenantId" = $1 AND u."deletedAt" IS NULL
        ORDER BY u."createdAt" DESC`,
      [tenantId],
    );
    return r.rows;
  }

  /**
   * Update a tenant user's dni and/or password. dni must be exactly 8 digits.
   * Password is bcrypt-hashed before storage. Scoped by tenantId so a
   * superadmin can edit credentials for any association.
   */
  async updateUserCredentials(
    tenantId: string,
    userId: string,
    data: { dni?: string; password?: string },
  ) {
    const userRes = await this.pool.query(
      `SELECT id FROM "User"
         WHERE id = $1 AND "tenantId" = $2 AND "deletedAt" IS NULL
         LIMIT 1`,
      [userId, tenantId],
    );
    if (!userRes.rows[0]) {
      throw new HttpException(
        'Usuario no encontrado en esta asociación',
        HttpStatus.NOT_FOUND,
      );
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (data.dni !== undefined) {
      if (!/^\d{8}$/.test(data.dni)) {
        throw new HttpException(
          'El DNI debe tener exactamente 8 dígitos',
          HttpStatus.BAD_REQUEST,
        );
      }
      const dup = await this.pool.query(
        `SELECT id FROM "User"
           WHERE "tenantId" = $1 AND dni = $2 AND id <> $3 AND "deletedAt" IS NULL
           LIMIT 1`,
        [tenantId, data.dni, userId],
      );
      if (dup.rows[0]) {
        throw new HttpException(
          `Ya existe otro usuario con DNI ${data.dni} en esta asociación`,
          HttpStatus.CONFLICT,
        );
      }
      fields.push(`dni = $${i++}`);
      values.push(data.dni);
    }

    if (data.password !== undefined) {
      if (!data.password) {
        throw new HttpException(
          'La contraseña no puede estar vacía',
          HttpStatus.BAD_REQUEST,
        );
      }
      fields.push(`password = $${i++}`);
      values.push(bcrypt.hashSync(data.password, 10));
    }

    if (fields.length === 0) {
      throw new HttpException(
        'Nada que actualizar: envía dni y/o password',
        HttpStatus.BAD_REQUEST,
      );
    }

    fields.push(`"updatedAt" = NOW()`);
    values.push(userId);
    const r = await this.pool.query(
      `UPDATE "User" SET ${fields.join(', ')} WHERE id = $${i}
         RETURNING id, name, lastname, dni, email, phone, "createdAt"`,
      values,
    );
    return r.rows[0];
  }

  // ---- Invitations (AppInvitation, scoped by tenant) ----

  async listInvitations(tenantId: string) {
    const r = await this.pool.query(
      `SELECT i.id, i."tenantId", i."userId", i.dni, i.status,
              i."invitedBy", i."acceptedAt", i."createdAt", i."updatedAt",
              u.name, u.lastname, u.email
         FROM "AppInvitation" i
         LEFT JOIN "User" u ON u.id = i."userId"
        WHERE i."tenantId" = $1
        ORDER BY i."createdAt" DESC`,
      [tenantId],
    );
    return r.rows;
  }

  async createInvitation(tenantId: string, dni: string) {
    if (!dni) {
      throw new HttpException('dni es requerido', HttpStatus.BAD_REQUEST);
    }
    const userRes = await this.pool.query(
      `SELECT id FROM "User"
         WHERE "tenantId" = $1 AND dni = $2 AND "deletedAt" IS NULL
         LIMIT 1`,
      [tenantId, dni],
    );
    const user = userRes.rows[0];
    if (!user) {
      throw new HttpException(
        `No existe un usuario con DNI ${dni} en esta ACA`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const dup = await this.pool.query(
      `SELECT id FROM "AppInvitation"
         WHERE "tenantId" = $1 AND dni = $2 AND status = 'pending'`,
      [tenantId, dni],
    );
    if (dup.rows.length > 0) {
      throw new HttpException(
        'Ya existe una invitación pendiente para ese DNI',
        HttpStatus.CONFLICT,
      );
    }

    const r = await this.pool.query(
      `INSERT INTO "AppInvitation"
         (id, "tenantId", "userId", dni, status, "invitedBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'pending', 'superadmin', NOW(), NOW())
       RETURNING id, "tenantId", "userId", dni, status, "invitedBy",
                 "acceptedAt", "createdAt", "updatedAt"`,
      [randomUUID(), tenantId, user.id, dni],
    );
    return r.rows[0];
  }

  async deleteInvitation(tenantId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM "AppInvitation" WHERE id = $1 AND "tenantId" = $2`,
      [id, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async getTotalCount(): Promise<number> {
    const r = await this.pool.query('SELECT COUNT(*) as count FROM tenants');
    return parseInt(r.rows[0].count);
  }
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) {
    const inner = v.map((x) => sqlLiteral(x)).join(', ');
    return `ARRAY[${inner}]`;
  }
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
