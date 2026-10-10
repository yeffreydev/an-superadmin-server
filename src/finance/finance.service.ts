import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import axios, { Method } from 'axios';
import { Pool } from 'pg';
import { appConfig } from '../config';
import { TenantsService } from '../tenants/tenants.service';

/**
 * Operations of the "Ingresos y egresos" module that the superadmin may run on
 * an association. Everything else of the unicas API stays out of reach.
 *
 * Each entry is `[methods, path regex]`, matched against the path *after*
 * `/finance/:tenantId/`.
 */
const ALLOWED: Array<[Method[], RegExp]> = [
  // Lookups the forms need
  [['GET'], /^users$/],
  [['GET'], /^banks$/],
  [['GET'], /^banks\/social-funds-types$/],
  [['GET'], /^schedules\/installments\/current-month$/],

  // Ingresos
  [['GET', 'POST'], /^deposits$/],
  [['PUT', 'DELETE'], /^deposits\/[\w-]+$/],
  [['GET'], /^stocks$/],
  [['POST'], /^stocks\/buy$/],
  [['PUT', 'DELETE'], /^stocks\/[\w-]+$/],
  [['GET', 'POST'], /^incomes\/loan-payments$/],
  [['PATCH', 'DELETE'], /^incomes\/loan-payments\/[\w-]+$/],
  [['GET'], /^(incomes\/(social-funds|others)|expenses\/(administrative|dividends|social-funds|others)|withdrawals|payouts)\/transactions$/],
  [['POST'], /^(incomes\/(social-funds|others)|expenses\/(administrative|dividends|social-funds|others)|withdrawals|payouts)\/create-transaction$/],
  [['DELETE'], /^(incomes\/(social-funds|others)|expenses\/(administrative|dividends|social-funds|others)|withdrawals|payouts)\/[\w-]+$/],

  // Préstamos
  [['GET', 'POST'], /^loans$/],
  [['GET'], /^loans\/(types|paid-installments)$/],
  [['GET'], /^loans\/(installments|by-user)\/[\w-]+$/],
  [['PUT', 'DELETE'], /^loans\/installments\/[\w-]+$/],
  [['PUT', 'DELETE'], /^loans\/[\w-]+$/],
  [['POST'], /^loans\/(mark-as-paid-all|pay-partial)\/[\w-]+$/],
];

/** Fields of the unicas API's rows that must never reach the panel. */
const SECRET_KEYS = new Set(['password', 'refreshToken']);

/** Users come with their password hash embedded (`include: { user: true }`). */
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

interface Session {
  token: string;
  tenantCode: string;
  expiresAt: number;
}

/** Lifetime of the tokens minted for the unicas API. */
const TOKEN_TTL_S = 10 * 60;

/**
 * Lets the superadmin operate the income/expense module of any association.
 *
 * The bookkeeping rules (installments, balances, schedule runs...) live in the
 * unicas API (`server`), so instead of duplicating them this service forwards
 * each whitelisted call there, signed as the association's administrator with
 * a short-lived token minted from the shared ACAS_JWT_SECRET.
 */
@Injectable()
export class FinanceService implements OnModuleDestroy {
  private readonly logger = new Logger(FinanceService.name);
  private readonly pool = new Pool({ connectionString: appConfig.ACAS_DATABASE_URL });
  private readonly jwt = new JwtService({ secret: appConfig.ACAS_JWT_SECRET });
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly tenants: TenantsService) {}

  async onModuleDestroy() {
    await this.pool.end();
  }

  async forward(
    tenantId: string,
    method: string,
    path: string,
    query: Record<string, unknown>,
    body: unknown,
    actor: string,
  ): Promise<{ status: number; data: unknown }> {
    const verb = method.toUpperCase() as Method;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (!ALLOWED.some(([methods, re]) => methods.includes(verb) && re.test(clean))) {
      // 400, not 403: the panel reads a 403 as "second key expired".
      throw new BadRequestException(`Operación no permitida: ${verb} /${clean}`);
    }

    const session = await this.session(tenantId);
    if (verb !== 'GET') {
      this.logger.log(`[${actor}] ${verb} /${clean} en ${session.tenantCode}`);
    }

    try {
      const res = await axios.request({
        method: verb,
        url: `${appConfig.ACAS_SERVER_URL}/${clean}`,
        params: query,
        data: verb === 'GET' || verb === 'DELETE' ? undefined : body,
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Tenant-Code': session.tenantCode,
          'X-Tenant-ID': session.tenantCode,
        },
        timeout: 30000,
      });
      return { status: res.status, data: stripSecrets(res.data) };
    } catch (e: any) {
      if (e?.response) {
        const data = e.response.data;
        const message =
          (typeof data === 'object' && data?.message) || e.message || 'Error en la asociación';
        throw new HttpException(
          { statusCode: e.response.status, message },
          // A 401/403 from the unicas API means our minted token was refused,
          // not that the panel session is gone; never let the panel log out.
          e.response.status === 401 || e.response.status === 403 ? 502 : e.response.status,
        );
      }
      this.logger.error(`unicas API inaccesible: ${e?.message}`);
      throw new ServiceUnavailableException('No se pudo contactar al servidor de la asociación');
    }
  }

  /** Token for the association, reused while it is fresh. */
  private async session(tenantId: string): Promise<Session> {
    const cached = this.sessions.get(tenantId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached;

    if (!appConfig.ACAS_JWT_SECRET) {
      throw new ServiceUnavailableException('ACAS_JWT_SECRET no está configurado');
    }

    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new NotFoundException('Asociación no encontrada');
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundException('Asociación no encontrada');

    // The unicas API resolves the tenant from the token's subject, so it has
    // to be a real administrator of this association.
    const admin = await this.pool.query<{ id: string }>(
      `SELECT u.id FROM "User" u
         JOIN "Role" r ON r.id = u."roleId"
        WHERE u."tenantId" = $1 AND r.name = 'Admin' AND u."deletedAt" IS NULL
        ORDER BY u."createdAt" ASC
        LIMIT 1`,
      [tenantId],
    );
    const sub = admin.rows[0]?.id;
    if (!sub) {
      throw new BadRequestException('La asociación no tiene un usuario administrador');
    }

    const token = this.jwt.sign(
      { sub, roles: ['Admin'], tenantId, impersonatedBy: 'superadmin' },
      { expiresIn: TOKEN_TTL_S },
    );
    const session = {
      token,
      tenantCode: tenant.code,
      expiresAt: Date.now() + TOKEN_TTL_S * 1000,
    };
    this.sessions.set(tenantId, session);
    return session;
  }
}
