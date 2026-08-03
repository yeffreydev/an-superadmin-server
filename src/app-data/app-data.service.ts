import {
  Injectable, OnModuleInit, OnModuleDestroy,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { appConfig } from '../config';

interface PlanInfo {
  id: string;
  key: string;
  name: string;
  status: string;
  endsAt: string | null;
}

interface CapitalBreakdown {
  loansTotal: number;
  capitalPaymentsTotal: number;
  monthNetBalance: number;
  capital: number;
}

@Injectable()
export class AppDataService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;        // QIPI db
  private acasPool: Pool;    // unified ACAS db (was masterPool)

  onModuleInit() {
    this.pool = new Pool({ connectionString: appConfig.QIPI_DATABASE_URL });
    this.acasPool = new Pool({ connectionString: appConfig.ACAS_DATABASE_URL });
  }

  async onModuleDestroy() {
    await this.pool.end();
    await this.acasPool.end();
  }

  async getUsers() {
    const result = await this.pool.query(`
      SELECT au.*,
        json_agg(
          json_build_object('id', u.id, 'name', u.name)
        ) FILTER (WHERE u.id IS NOT NULL) as unicas
      FROM "AppUser" au
      LEFT JOIN "UserUnica" uu ON au.id = uu."appUserId"
      LEFT JOIN "Unica" u ON uu."unicaId" = u.id
      GROUP BY au.id
      ORDER BY au."createdAt" DESC
    `);
    return result.rows;
  }

  async getUserById(id: string) {
    const userResult = await this.pool.query(
      'SELECT * FROM "AppUser" WHERE id = $1',
      [id],
    );
    if (userResult.rows.length === 0) return null;

    const unicasResult = await this.pool.query(
      `SELECT u.* FROM "Unica" u
       JOIN "UserUnica" uu ON u.id = uu."unicaId"
       WHERE uu."appUserId" = $1`,
      [id],
    );

    return { ...userResult.rows[0], unicas: unicasResult.rows };
  }

  async deleteUser(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const exists = await client.query(
        'SELECT id FROM "AppUser" WHERE id = $1',
        [id],
      );
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('DELETE FROM "ForumMessage" WHERE "authorId" = $1', [id]);
      await client.query('DELETE FROM "UserUnica" WHERE "appUserId" = $1', [id]);
      const r = await client.query('DELETE FROM "AppUser" WHERE id = $1', [id]);

      await client.query('COMMIT');
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Links an app user to a unica (ACA) from the superadmin.
   * Mirrors what the app's invite flow stores in "UserUnica": it needs the
   * ACAS-side User.id (serverUserId), resolved by matching the app user's
   * dni inside that unica's tenant.
   */
  async addUserToUnica(appUserId: string, unicaId: string) {
    const userRes = await this.pool.query(
      'SELECT id, dni, name FROM "AppUser" WHERE id = $1',
      [appUserId],
    );
    const appUser = userRes.rows[0];
    if (!appUser) {
      throw new HttpException('Usuario no encontrado', HttpStatus.NOT_FOUND);
    }

    const unicaRes = await this.pool.query(
      'SELECT id, name, "tenantId" FROM "Unica" WHERE id = $1',
      [unicaId],
    );
    const unica = unicaRes.rows[0];
    if (!unica) {
      throw new HttpException(
        'ACA no encontrada o no registrada en la app',
        HttpStatus.NOT_FOUND,
      );
    }

    const dup = await this.pool.query(
      'SELECT id FROM "UserUnica" WHERE "appUserId" = $1 AND "unicaId" = $2',
      [appUserId, unicaId],
    );
    if (dup.rows.length > 0) {
      throw new HttpException(
        'El usuario ya pertenece a esta ACA',
        HttpStatus.CONFLICT,
      );
    }

    // Unica.tenantId on the QIPI side is the tenant *code* (domain).
    const tenantRes = await this.acasPool.query(
      'SELECT id FROM tenants WHERE code = $1 LIMIT 1',
      [unica.tenantId],
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) {
      throw new HttpException(
        `No existe el tenant "${unica.tenantId}" en la base ACAS`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const serverUserRes = await this.acasPool.query(
      `SELECT id FROM "User"
         WHERE "tenantId" = $1 AND dni = $2 AND "deletedAt" IS NULL
         LIMIT 1`,
      [tenant.id, appUser.dni],
    );
    const serverUser = serverUserRes.rows[0];
    if (!serverUser) {
      throw new HttpException(
        `No existe un usuario con DNI ${appUser.dni} dentro de la ACA "${unica.name}". ` +
          'Crea primero ese usuario en la ACA.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.pool.query(
      `INSERT INTO "UserUnica"
         (id, "appUserId", "unicaId", "serverUserId", status,
          "invitedAt", "acceptedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'active', NOW(), NOW(), NOW(), NOW())`,
      [randomUUID(), appUserId, unicaId, serverUser.id],
    );

    return { success: true, unica: { id: unica.id, name: unica.name } };
  }

  async removeUserFromUnica(appUserId: string, unicaId: string) {
    const r = await this.pool.query(
      'DELETE FROM "UserUnica" WHERE "appUserId" = $1 AND "unicaId" = $2',
      [appUserId, unicaId],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new HttpException('Vínculo no encontrado', HttpStatus.NOT_FOUND);
    }
    return { success: true };
  }

  async getUnicas() {
    const tenantsRes = await this.acasPool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants ORDER BY "createdAt" DESC`,
    );
    const tenants = tenantsRes.rows as Array<{
      id: string;
      code: string;
      name: string | null;
      active: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
    if (tenants.length === 0) return [];

    // QIPI side still tracks the unica by the tenant *code* (domain).
    const codes = tenants.map((t) => t.code);
    const unicasRes = await this.pool.query(
      `SELECT u.*, COUNT(uu."appUserId") as "userCount"
       FROM "Unica" u
       LEFT JOIN "UserUnica" uu ON u.id = uu."unicaId"
       WHERE u."tenantId" = ANY($1::text[])
       GROUP BY u.id`,
      [codes],
    );
    const unicaByCode = new Map<string, any>();
    for (const u of unicasRes.rows) unicaByCode.set(u.tenantId, u);

    const enriched = await Promise.all(
      tenants.map(async (t) => {
        const u = unicaByCode.get(t.code);
        const [plan, capital] = await Promise.all([
          this.getTenantPlan(t.id).catch(() => null),
          this.getTenantCapital(t.id).catch(() => null),
        ]);
        return {
          id: u?.id ?? t.id,
          tenantId: t.id,
          code: t.code,
          name: u?.name ?? t.name ?? t.code,
          description: u?.description ?? null,
          avatar: u?.avatar ?? null,
          active: t.active && (u?.active ?? true),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          userCount: u?.userCount ?? '0',
          registeredInApp: Boolean(u),
          plan,
          capital: capital?.capital ?? null,
          capitalBreakdown: capital,
          moduleReady: Boolean(plan && plan.status === 'active'),
        };
      }),
    );
    return enriched;
  }

  async getUnicaById(idOrCode: string) {
    // 1. resolve the tenants row by id OR code
    const tenantRow = await this.acasPool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants WHERE id::text = $1 OR code = $1 LIMIT 1`,
      [idOrCode],
    );
    const tenant = tenantRow.rows[0] ?? null;
    if (!tenant) return null;

    // 2. QIPI side
    const unicaResult = await this.pool.query(
      'SELECT * FROM "Unica" WHERE id = $1 OR "tenantId" = $2 LIMIT 1',
      [idOrCode, tenant.code],
    );
    const unica = unicaResult.rows[0] ?? null;

    const usersResult = unica
      ? await this.pool.query(
          `SELECT au.* FROM "AppUser" au
           JOIN "UserUnica" uu ON au.id = uu."appUserId"
           WHERE uu."unicaId" = $1`,
          [unica.id],
        )
      : { rows: [] };

    const [plan, capital] = await Promise.all([
      this.getTenantPlan(tenant.id).catch(() => null),
      this.getTenantCapital(tenant.id).catch(() => null),
    ]);

    return {
      id: unica?.id ?? tenant.id,
      tenantId: tenant.id,
      code: tenant.code,
      name: unica?.name ?? tenant.name ?? tenant.code,
      description: unica?.description ?? null,
      avatar: unica?.avatar ?? null,
      active: tenant.active && (unica?.active ?? true),
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
      registeredInApp: Boolean(unica),
      users: usersResult.rows,
      plan,
      capital: capital?.capital ?? null,
      capitalBreakdown: capital,
      moduleReady: Boolean(plan && plan.status === 'active'),
    };
  }

  async getForumMessages(unicaIdOrCode: string) {
    const unicaRes = await this.pool.query(
      `SELECT id FROM "Unica" WHERE id = $1 OR "tenantId" = $1 LIMIT 1`,
      [unicaIdOrCode],
    );
    if (unicaRes.rows.length === 0) return [];
    const unicaId = unicaRes.rows[0].id;

    const result = await this.pool.query(
      `SELECT fm.*, au.name as "userName", au.email as "userEmail"
       FROM "ForumMessage" fm
       LEFT JOIN "AppUser" au ON fm."authorId" = au.id
       WHERE fm."unicaId" = $1
       ORDER BY fm."createdAt" DESC`,
      [unicaId],
    );
    return result.rows;
  }

  /**
   * Resolves an incoming AppUnica id (which is `unica?.id ?? tenant.id`,
   * so it may be a tenant UUID, a tenant code, or a QIPI Unica.id) into the
   * ACAS tenant UUID/code and the QIPI Unica.id (null if not registered in app).
   */
  private async resolveTenant(idOrCode: string) {
    const t = await this.acasPool.query(
      `SELECT id, code FROM tenants WHERE id::text = $1 OR code = $1 LIMIT 1`,
      [idOrCode],
    );
    const tenant = t.rows[0] ?? null;
    if (!tenant) return null;
    const u = await this.pool.query(
      `SELECT id FROM "Unica" WHERE id = $1 OR "tenantId" = $2 LIMIT 1`,
      [idOrCode, tenant.code],
    );
    return {
      tenantId: tenant.id as string,
      code: tenant.code as string,
      unicaId: (u.rows[0]?.id ?? null) as string | null,
    };
  }

  /** Lists the assemblies (ScheduleRun) of an association. */
  async getAssemblies(idOrCode: string) {
    const resolved = await this.resolveTenant(idOrCode);
    if (!resolved) {
      throw new HttpException('Unica no encontrada', HttpStatus.NOT_FOUND);
    }
    const r = await this.acasPool.query(
      `SELECT id, topic, status, "startAt", "endAt", "openAt", "closeAt", place, "createdAt"
         FROM "ScheduleRun"
        WHERE "tenantId" = $1 AND "deletedAt" IS NULL
        ORDER BY "startAt" DESC NULLS LAST, "createdAt" DESC`,
      [resolved.tenantId],
    );
    return r.rows;
  }

  // Child tables of a ScheduleRun, keyed by "scheduleRunId".
  private static readonly RUN_CHILD_TABLES = [
    'Acta', 'ScheduleAgenda', 'ScheduleParticipant', 'LoanPayment', 'UserStock',
    'CreditApplication', 'Deposits', 'Withdrawals', 'DepositorPayouts',
    'AdministrativeExpenses', 'Dividends', 'OtherExpenses', 'OtherIncomes',
    'SocialFundsIncomes', 'SocialFundsExpenses',
  ];

  /**
   * Resets one assembly: wipes its recorded data (all child tables) but keeps
   * the ScheduleRun row, leaving it scheduled/clean.
   */
  async resetAssembly(idOrCode: string, runId: string) {
    const resolved = await this.resolveTenant(idOrCode);
    if (!resolved) {
      throw new HttpException('Unica no encontrada', HttpStatus.NOT_FOUND);
    }
    const runRes = await this.acasPool.query(
      `SELECT id FROM "ScheduleRun" WHERE id = $1 AND "tenantId" = $2 LIMIT 1`,
      [runId, resolved.tenantId],
    );
    if (runRes.rows.length === 0) {
      throw new HttpException('Asamblea no encontrada', HttpStatus.NOT_FOUND);
    }

    const client = await this.acasPool.connect();
    try {
      await client.query('BEGIN');
      for (const table of AppDataService.RUN_CHILD_TABLES) {
        await client.query(
          `DELETE FROM "${table}" WHERE "scheduleRunId" = $1`,
          [runId],
        );
      }
      await client.query(
        `UPDATE "ScheduleRun"
            SET status = 'scheduled', "openAt" = NULL, "closeAt" = NULL, "endAt" = NULL
          WHERE id = $1`,
        [runId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { success: true };
  }

  /**
   * Resets an entire association: wipes all assemblies + financial data (ACAS)
   * and the forum + memberships (QIPI), keeping only the initial config and the
   * members (Users). Not atomic across the two databases (ACAS first, then QIPI);
   * both wipes are idempotent, so re-running completes a partial reset.
   */
  async resetUnica(idOrCode: string) {
    const resolved = await this.resolveTenant(idOrCode);
    if (!resolved) {
      throw new HttpException('Unica no encontrada', HttpStatus.NOT_FOUND);
    }
    const { tenantId, unicaId } = resolved;

    // --- Tx ACAS: transactional/financial data, child -> parent order ---
    const acas = await this.acasPool.connect();
    try {
      await acas.query('BEGIN');
      // ScheduleRun children first (keep the schedule-level participant roster)
      await acas.query(`DELETE FROM "Acta" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "ScheduleAgenda" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(
        `DELETE FROM "ScheduleParticipant" WHERE "tenantId" = $1 AND "scheduleRunId" IS NOT NULL`,
        [tenantId],
      );
      await acas.query(`DELETE FROM "LoanPayment" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "CreditApplication" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "UserStock" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "Deposits" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "Withdrawals" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "DepositorPayouts" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "AdministrativeExpenses" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "Dividends" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "OtherExpenses" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "OtherIncomes" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "SocialFundsIncomes" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "SocialFundsExpenses" WHERE "tenantId" = $1`, [tenantId]);
      // Loan graph after its referencing rows are gone
      await acas.query(`DELETE FROM "LoanInstallment" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query(`DELETE FROM "Loan" WHERE "tenantId" = $1`, [tenantId]);
      // Finally the runs themselves (all children removed above)
      await acas.query(`DELETE FROM "ScheduleRun" WHERE "tenantId" = $1`, [tenantId]);
      await acas.query('COMMIT');
    } catch (e) {
      await acas.query('ROLLBACK');
      throw e;
    } finally {
      acas.release();
    }

    // --- Tx QIPI: forum + memberships (only if registered in app) ---
    if (unicaId) {
      const qipi = await this.pool.connect();
      try {
        await qipi.query('BEGIN');
        await qipi.query(`DELETE FROM "ForumMessage" WHERE "unicaId" = $1`, [unicaId]);
        await qipi.query(`DELETE FROM "UserUnica" WHERE "unicaId" = $1`, [unicaId]);
        await qipi.query('COMMIT');
      } catch (e) {
        await qipi.query('ROLLBACK');
        throw e;
      } finally {
        qipi.release();
      }
    }

    return { success: true };
  }

  async getOverallStats() {
    const [usersRes, unicasRes, messagesRes] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as count FROM "AppUser"'),
      this.pool.query('SELECT COUNT(*) as count FROM "Unica"'),
      this.pool.query('SELECT COUNT(*) as count FROM "ForumMessage"'),
    ]);

    return {
      totalUsers: parseInt(usersRes.rows[0].count),
      totalUnicas: parseInt(unicasRes.rows[0].count),
      totalForumMessages: parseInt(messagesRes.rows[0].count),
    };
  }

  /** Plan now keyed by tenant UUID (tenants.id). */
  private async getTenantPlan(tenantId: string): Promise<PlanInfo | null> {
    const r = await this.acasPool.query(
      `SELECT s.id, s.status, s.ends_at, p.id AS plan_id, p.key, p.name
       FROM tenant_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1
       ORDER BY (s.status = 'active') DESC, s.starts_at DESC
       LIMIT 1`,
      [tenantId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      id: row.plan_id,
      key: row.key,
      name: row.name,
      status: row.status,
      endsAt: row.ends_at,
    };
  }

  private async getTenantCapital(tenantId: string): Promise<CapitalBreakdown | null> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [loansRes, paymentsRes, depositsRes, withdrawalsRes] = await Promise.all([
      this.acasPool.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total FROM "Loan"
           WHERE "deletedAt" IS NULL AND "tenantId" = $1`,
        [tenantId],
      ),
      this.acasPool.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total FROM "LoanPayment"
           WHERE "deletedAt" IS NULL AND "tenantId" = $1`,
        [tenantId],
      ),
      this.acasPool.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total FROM "Deposits"
           WHERE "deletedAt" IS NULL AND "createdAt" >= $1 AND "createdAt" < $2 AND "tenantId" = $3`,
        [monthStart, monthEnd, tenantId],
      ),
      this.acasPool.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total FROM "Withdrawals"
           WHERE "deletedAt" IS NULL AND "createdAt" >= $1 AND "createdAt" < $2 AND "tenantId" = $3`,
        [monthStart, monthEnd, tenantId],
      ),
    ]);

    const loansTotal = Number(loansRes.rows[0].total) || 0;
    const capitalPaymentsTotal = Number(paymentsRes.rows[0].total) || 0;
    const monthNetBalance =
      (Number(depositsRes.rows[0].total) || 0) - (Number(withdrawalsRes.rows[0].total) || 0);
    const capital = loansTotal - capitalPaymentsTotal + monthNetBalance;

    return {
      loansTotal: round2(loansTotal),
      capitalPaymentsTotal: round2(capitalPaymentsTotal),
      monthNetBalance: round2(monthNetBalance),
      capital: round2(capital),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
