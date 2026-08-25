import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Association } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService, TenantRow } from '../tenants/tenants.service';
import { appConfig } from '../config';

/** Credentials the tenant seed creates, handed to the creator once. */
export const SEEDED_ADMIN_CREDENTIALS = {
  dni: '12345678',
  password: '12345678',
};

export interface AssociationView {
  id: string;
  tenantId: string;
  tenantCode: string;
  name: string | null;
  createdAt: Date;
  /** Live tenant row from the ACAS database; null if it was deleted there. */
  tenant: TenantRow | null;
  active: boolean;
}

// Subdomains that must never become an association host.
const RESERVED_SUBDOMAINS = new Set([
  'admin', 'superadmin', 'api', 'app', 'www', 'panel', 'saley', 'appserver',
  'mail', 'ftp', 'cdn', 'static', 'dev', 'test', 'staging',
]);

// A tenant code is a hostname: labels of letters/digits/hyphens split by dots.
const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}

/**
 * Associations owned by a panel account.
 *
 * The association itself lives in the ACAS database (a `tenant` row plus its
 * seeded catalogs, all handled by TenantsService); this service only owns the
 * account → tenant link stored in the superadmin database, and enforces that an
 * admin can only ever touch the associations they created.
 */
@Injectable()
export class AssociationsService {
  private readonly logger = new Logger(AssociationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
  ) {}

  async listForOwner(ownerId: string): Promise<AssociationView[]> {
    const rows = await this.prisma.association.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((row) => this.decorate(row)));
  }

  /** Every association with its owner — superadmin view. */
  async listAll() {
    const rows = await this.prisma.association.findMany({
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { id: true, email: true, name: true } } },
    });
    return rows;
  }

  /** Owner map keyed by tenantId, for enriching the superadmin tenant list. */
  async ownersByTenantId(): Promise<Record<string, { id: string; email: string; name: string | null }>> {
    const rows = await this.prisma.association.findMany({
      include: { owner: { select: { id: true, email: true, name: true } } },
    });
    const map: Record<string, { id: string; email: string; name: string | null }> = {};
    for (const row of rows) map[row.tenantId] = row.owner;
    return map;
  }

  /** Loads an association, failing unless it belongs to `ownerId`. */
  async getOwned(ownerId: string, id: string): Promise<Association> {
    const row = await this.prisma.association.findUnique({ where: { id } });
    // Same error for "missing" and "someone else's" so ids can't be probed.
    if (!row || row.ownerId !== ownerId) {
      throw new NotFoundException('Asociación no encontrada');
    }
    return row;
  }

  async getOwnedView(ownerId: string, id: string): Promise<AssociationView> {
    return this.decorate(await this.getOwned(ownerId, id));
  }

  async create(
    ownerId: string,
    input: { name: string; code?: string },
  ): Promise<AssociationView & { qipiConnected: boolean; qipiError?: string; credentials: typeof SEEDED_ADMIN_CREDENTIALS }> {
    const name = (input.name ?? '').trim();
    if (!name) {
      throw new BadRequestException('El nombre de la asociación es requerido');
    }

    const code = input.code?.trim()
      ? this.validateCode(input.code.trim())
      : await this.generateCode(name);

    if (await this.tenants.findByCode(code)) {
      throw new ConflictException(`El código "${code}" ya está en uso`);
    }

    const tenant = await this.tenants.create(code, name);

    const row = await this.prisma.association.create({
      data: {
        tenantId: tenant.id,
        tenantCode: tenant.code,
        name: tenant.name,
        ownerId,
      },
    });

    if (!tenant.qipiConnected) {
      this.logger.warn(
        `Asociación "${code}" creada sin conexión con la app: ${tenant.qipiError}`,
      );
    }

    return {
      ...(await this.decorate(row, tenant)),
      qipiConnected: tenant.qipiConnected,
      qipiError: tenant.qipiError,
      credentials: SEEDED_ADMIN_CREDENTIALS,
    };
  }

  async rename(ownerId: string, id: string, name: string): Promise<AssociationView> {
    const row = await this.getOwned(ownerId, id);
    const clean = (name ?? '').trim();
    if (!clean) throw new BadRequestException('El nombre es requerido');
    await this.tenants.update(row.tenantId, { name: clean });
    const updated = await this.prisma.association.update({
      where: { id: row.id },
      data: { name: clean },
    });
    return this.decorate(updated);
  }

  // --- Delegations, all gated on ownership ----------------------------------

  async stats(ownerId: string, id: string) {
    const row = await this.getOwned(ownerId, id);
    return this.tenants.getStats(row.tenantId);
  }

  async users(ownerId: string, id: string) {
    const row = await this.getOwned(ownerId, id);
    return this.tenants.listUsers(row.tenantId);
  }

  async updateUserCredentials(
    ownerId: string,
    id: string,
    userId: string,
    data: { dni?: string; password?: string },
  ) {
    const row = await this.getOwned(ownerId, id);
    return this.tenants.updateUserCredentials(row.tenantId, userId, data);
  }

  async invitations(ownerId: string, id: string) {
    const row = await this.getOwned(ownerId, id);
    return this.tenants.listInvitations(row.tenantId);
  }

  async createInvitation(ownerId: string, id: string, dni: string) {
    const row = await this.getOwned(ownerId, id);
    return this.tenants.createInvitation(row.tenantId, dni);
  }

  async deleteInvitation(ownerId: string, id: string, invId: string) {
    const row = await this.getOwned(ownerId, id);
    const ok = await this.tenants.deleteInvitation(row.tenantId, invId);
    if (!ok) throw new NotFoundException('Invitación no encontrada');
    return { success: true };
  }

  async connectApp(ownerId: string, id: string) {
    const row = await this.getOwned(ownerId, id);
    return this.tenants.connectToQipi(row.tenantId);
  }

  /**
   * Opens the association's own onboarding (`/start` in unica-system) for its
   * creator: signs in against the unicas API with the seeded admin and returns
   * a URL carrying the session token in the fragment, so the creator lands
   * already logged in instead of retyping the seeded credentials.
   *
   * The token travels in the hash, which browsers never send to a server and
   * which the app strips from the URL as soon as it reads it.
   */
  async onboardingSession(
    ownerId: string,
    id: string,
  ): Promise<{ url: string; autoLogin: boolean; credentials: typeof SEEDED_ADMIN_CREDENTIALS }> {
    const row = await this.getOwned(ownerId, id);
    const appBase = appConfig.UNICA_APP_URL || `https://${row.tenantCode}`;

    try {
      const res = await axios.post<{ accessToken: string }>(
        `${appConfig.ACAS_SERVER_URL}/auth/login`,
        {
          username: SEEDED_ADMIN_CREDENTIALS.dni,
          password: SEEDED_ADMIN_CREDENTIALS.password,
        },
        {
          headers: {
            'X-Tenant-Code': row.tenantCode,
            'X-Tenant-ID': row.tenantCode,
          },
          timeout: 15000,
        },
      );
      const token = res.data?.accessToken;
      if (!token) throw new Error('El servidor de la asociación no devolvió token');
      return {
        url: `${appBase}/start#token=${encodeURIComponent(token)}`,
        autoLogin: true,
        credentials: SEEDED_ADMIN_CREDENTIALS,
      };
    } catch (e: any) {
      // The seeded password may already have been changed, or the unicas API
      // may be down: fall back to the plain login screen instead of failing
      // the whole onboarding.
      const msg = e?.response?.data?.message || e.message;
      this.logger.warn(
        `No se pudo abrir sesión de onboarding en "${row.tenantCode}": ${msg}`,
      );
      return {
        url: `${appBase}/login`,
        autoLogin: false,
        credentials: SEEDED_ADMIN_CREDENTIALS,
      };
    }
  }

  async backup(ownerId: string, id: string) {
    const row = await this.getOwned(ownerId, id);
    return {
      code: row.tenantCode,
      sql: await this.tenants.generateBackup(row.tenantId),
    };
  }

  // --- Internals ------------------------------------------------------------

  private async decorate(row: Association, tenant?: TenantRow): Promise<AssociationView> {
    const live = tenant ?? (await this.tenants.findById(row.tenantId));
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantCode: row.tenantCode,
      name: live?.name ?? row.name,
      createdAt: row.createdAt,
      tenant: live,
      active: live?.active ?? false,
    };
  }

  /**
   * A code is the hostname the association is served on. Callers may pass a
   * bare subdomain ("losandes") — it gets completed with ASSOCIATION_DOMAIN —
   * or a full host ("losandes.aquinace.com", or a custom domain).
   */
  private validateCode(code: string): string {
    const clean = code.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const host = clean.includes('.') ? clean : this.hostFor(clean);
    const label = host.split('.')[0];
    if (label.length < 3 || !HOST_RE.test(host) || host.length > 253) {
      throw new BadRequestException(
        'El código debe ser un dominio válido, por ejemplo: losandes.aquinace.com',
      );
    }
    if (RESERVED_SUBDOMAINS.has(label) && host.endsWith(appConfig.ASSOCIATION_DOMAIN)) {
      throw new BadRequestException(`El subdominio "${label}" está reservado`);
    }
    return host;
  }

  /**
   * Derives a free host from the name:
   * "Los Andes" → losandes.aquinace.com, then losandes2.aquinace.com, ...
   */
  private async generateCode(name: string): Promise<string> {
    const base = slugify(name) || 'aca';
    const seed = base.length < 3 ? `${base}aca`.slice(0, 6) : base;
    for (let i = 0; i < 50; i++) {
      const label = i === 0 ? seed : `${seed}${i + 1}`;
      if (RESERVED_SUBDOMAINS.has(label)) continue;
      const candidate = this.hostFor(label);
      if (!(await this.tenants.findByCode(candidate))) return candidate;
    }
    throw new ConflictException(
      'No se pudo generar un código libre, indica uno manualmente',
    );
  }

  private hostFor(label: string): string {
    return `${label}.${appConfig.ASSOCIATION_DOMAIN}`;
  }
}
