import {
  Injectable, OnModuleInit, OnModuleDestroy,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { ClientStage, ContactKind, AttributeType } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { appConfig } from '../config';

export interface ClientUpdateDto {
  name?: string;
  stage?: ClientStage;
  responsibleName?: string | null;
  responsibleEmail?: string | null;
  responsiblePhone?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
}

export interface ClientCreateDto extends ClientUpdateDto {
  name: string;
  tenantId?: string | null;
  contacts?: ContactInput[];
}

export interface ContactInput {
  kind?: ContactKind;
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}

export interface ContactUpdateInput {
  kind?: ContactKind;
  name?: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}

export interface AttributeInput {
  key: string;
  value: string;
  type?: AttributeType;
  position?: number;
}

export interface AttributeUpdateInput {
  key?: string;
  value?: string;
  type?: AttributeType;
  position?: number;
}

interface TenantRow {
  id: string;
  code: string;
  name: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: string;
  key: string;
  name: string;
  status: string;
  endsAt: string | null;
}

@Injectable()
export class ClientsService implements OnModuleInit, OnModuleDestroy {
  private acasPool: Pool;
  private qipiPool: Pool;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.acasPool = new Pool({ connectionString: appConfig.ACAS_DATABASE_URL });
    this.qipiPool = new Pool({ connectionString: appConfig.QIPI_DATABASE_URL });
  }

  async onModuleDestroy() {
    await this.acasPool.end();
    await this.qipiPool.end();
  }

  // ---------- helpers ----------

  private async loadTenants(): Promise<TenantRow[]> {
    const r = await this.acasPool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants ORDER BY "createdAt" DESC`,
    );
    return r.rows;
  }

  private async loadTenantById(id: string): Promise<TenantRow | null> {
    const r = await this.acasPool.query(
      `SELECT id, code, name, active, "createdAt", "updatedAt"
         FROM tenants WHERE id::text = $1 OR code = $1 LIMIT 1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  private async loadPlan(tenantId: string): Promise<PlanRow | null> {
    const r = await this.acasPool.query(
      `SELECT s.status, s.ends_at, p.id AS plan_id, p.key, p.name
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

  private async loadUnicaUserCount(tenantCode: string): Promise<number> {
    const r = await this.qipiPool.query(
      `SELECT COUNT(uu."appUserId")::int AS count
         FROM "Unica" u
         LEFT JOIN "UserUnica" uu ON u.id = uu."unicaId"
         WHERE u."tenantId" = $1`,
      [tenantCode],
    );
    return r.rows[0]?.count ?? 0;
  }

  private deriveStage(plan: PlanRow | null, active: boolean): ClientStage {
    if (!active) return ClientStage.INACTIVA;
    if (plan && plan.status === 'active') return ClientStage.IMPLEMENTADA;
    return ClientStage.PROSPECTO;
  }

  // ---------- list / get ----------

  async listClients() {
    const tenants = await this.loadTenants();
    const allClients = await this.prisma.client.findMany({
      include: {
        _count: { select: { comments: true, contacts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const byTenant = new Map(
      allClients.filter((c) => c.tenantId).map((c) => [c.tenantId as string, c]),
    );
    const standaloneClients = allClients.filter((c) => !c.tenantId);

    const tenantBacked = await Promise.all(
      tenants.map(async (t) => {
        const client = byTenant.get(t.id);
        const [plan, userCount] = await Promise.all([
          this.loadPlan(t.id).catch(() => null),
          this.loadUnicaUserCount(t.code).catch(() => 0),
        ]);
        const registered = Boolean(client);
        const derivedStage = this.deriveStage(plan, t.active);
        return {
          tenantId: t.id,
          tenantCode: t.code,
          name: client?.name ?? t.name ?? t.code,
          active: t.active,
          createdAt: t.createdAt,
          plan,
          userCount,
          registered,
          standalone: false,
          client: client
            ? {
                id: client.id,
                stage: client.stage,
                responsibleName: client.responsibleName,
                responsibleEmail: client.responsibleEmail,
                responsiblePhone: client.responsiblePhone,
                contactName: client.contactName,
                contactEmail: client.contactEmail,
                contactPhone: client.contactPhone,
                notes: client.notes,
                createdAt: client.createdAt,
                updatedAt: client.updatedAt,
                commentsCount: (client as any)._count?.comments ?? 0,
                contactsCount: (client as any)._count?.contacts ?? 0,
              }
            : null,
          suggestedStage: derivedStage,
        };
      }),
    );

    const standalone = standaloneClients.map((c) => ({
      tenantId: null,
      tenantCode: null,
      name: c.name,
      active: true,
      createdAt: c.createdAt,
      plan: null,
      userCount: 0,
      registered: true,
      standalone: true,
      client: {
        id: c.id,
        stage: c.stage,
        responsibleName: c.responsibleName,
        responsibleEmail: c.responsibleEmail,
        responsiblePhone: c.responsiblePhone,
        contactName: c.contactName,
        contactEmail: c.contactEmail,
        contactPhone: c.contactPhone,
        notes: c.notes,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        commentsCount: (c as any)._count?.comments ?? 0,
        contactsCount: (c as any)._count?.contacts ?? 0,
      },
      suggestedStage: c.stage,
    }));

    return [...standalone, ...tenantBacked];
  }

  async getClient(idOrTenant: string) {
    const client = await this.prisma.client.findFirst({
      where: { OR: [{ id: idOrTenant }, { tenantId: idOrTenant }] },
      include: {
        comments: { orderBy: { createdAt: 'desc' } },
        contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        attributes: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
      },
    });

    let tenant: TenantRow | null = null;
    if (client?.tenantId) {
      tenant = await this.loadTenantById(client.tenantId);
    } else if (!client) {
      tenant = await this.loadTenantById(idOrTenant);
    }

    if (!client && !tenant) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }

    const tenantId = tenant?.id ?? client?.tenantId ?? null;
    const tenantCode = tenant?.code ?? client?.tenantCode ?? null;

    const [plan, userCount] = tenantId
      ? await Promise.all([
          this.loadPlan(tenantId).catch(() => null),
          tenantCode ? this.loadUnicaUserCount(tenantCode).catch(() => 0) : Promise.resolve(0),
        ])
      : [null, 0];

    const suggestedStage = tenant
      ? this.deriveStage(plan, tenant.active)
      : (client?.stage ?? ClientStage.PROSPECTO);

    return {
      tenantId,
      tenantCode,
      tenantName: tenant?.name ?? null,
      tenantActive: tenant?.active ?? null,
      tenantCreatedAt: tenant?.createdAt ?? null,
      standalone: !tenantId,
      plan,
      userCount,
      suggestedStage,
      client: client
        ? {
            id: client.id,
            name: client.name,
            stage: client.stage,
            responsibleName: client.responsibleName,
            responsibleEmail: client.responsibleEmail,
            responsiblePhone: client.responsiblePhone,
            contactName: client.contactName,
            contactEmail: client.contactEmail,
            contactPhone: client.contactPhone,
            notes: client.notes,
            createdAt: client.createdAt,
            updatedAt: client.updatedAt,
            comments: client.comments.map((c) => ({
              id: c.id,
              author: c.author,
              content: c.content,
              createdAt: c.createdAt,
            })),
            contacts: client.contacts.map((c) => ({
              id: c.id,
              kind: c.kind,
              name: c.name,
              role: c.role,
              email: c.email,
              phone: c.phone,
              notes: c.notes,
              isPrimary: c.isPrimary,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            })),
            attributes: client.attributes.map((a) => ({
              id: a.id,
              key: a.key,
              value: a.value,
              type: a.type,
              position: a.position,
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            })),
          }
        : null,
    };
  }

  // ---------- create (standalone or tenant-backed) ----------

  async createClient(data: ClientCreateDto) {
    if (!data.name?.trim()) {
      throw new HttpException('El nombre es requerido', HttpStatus.BAD_REQUEST);
    }

    let tenant: TenantRow | null = null;
    if (data.tenantId) {
      tenant = await this.loadTenantById(data.tenantId);
      if (!tenant) {
        throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
      }
      const existing = await this.prisma.client.findUnique({
        where: { tenantId: tenant.id },
      });
      if (existing) {
        throw new HttpException(
          'Este tenant ya está registrado como cliente',
          HttpStatus.CONFLICT,
        );
      }
    }

    const plan = tenant ? await this.loadPlan(tenant.id).catch(() => null) : null;
    const stage = data.stage ?? (tenant ? this.deriveStage(plan, tenant.active) : ClientStage.PROSPECTO);

    const contactsInput = (data.contacts ?? [])
      .filter((c) => c.name?.trim())
      .map((c) => ({
        kind: c.kind ?? ContactKind.CONTACT,
        name: c.name.trim(),
        role: c.role?.trim() || null,
        email: c.email?.trim() || null,
        phone: c.phone?.trim() || null,
        notes: c.notes?.trim() || null,
        isPrimary: Boolean(c.isPrimary),
      }));

    return this.prisma.client.create({
      data: {
        tenantId: tenant?.id ?? null,
        tenantCode: tenant?.code ?? null,
        name: data.name.trim(),
        stage,
        responsibleName: data.responsibleName ?? null,
        responsibleEmail: data.responsibleEmail ?? null,
        responsiblePhone: data.responsiblePhone ?? null,
        contactName: data.contactName ?? null,
        contactEmail: data.contactEmail ?? null,
        contactPhone: data.contactPhone ?? null,
        notes: data.notes ?? null,
        contacts: contactsInput.length ? { create: contactsInput } : undefined,
      },
      include: { contacts: true },
    });
  }

  /** Legacy register: kept for compatibility with current tenant-linked flow. */
  async registerClient(tenantId: string, data: ClientUpdateDto) {
    return this.createClient({ ...data, name: data.name ?? '', tenantId });
  }

  // ---------- update / delete ----------

  async updateClient(id: string, data: ClientUpdateDto) {
    const existing = await this.prisma.client.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    return this.prisma.client.update({
      where: { id },
      data,
    });
  }

  async deleteClient(id: string) {
    const existing = await this.prisma.client.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    await this.prisma.client.delete({ where: { id } });
    return { success: true };
  }

  // ---------- tenant assignment ----------

  async assignTenant(clientId: string, tenantId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    if (client.tenantId) {
      throw new HttpException(
        'El cliente ya tiene una asociación asignada',
        HttpStatus.CONFLICT,
      );
    }
    const tenant = await this.loadTenantById(tenantId);
    if (!tenant) {
      throw new HttpException('Tenant no encontrado', HttpStatus.NOT_FOUND);
    }
    const taken = await this.prisma.client.findUnique({
      where: { tenantId: tenant.id },
    });
    if (taken) {
      throw new HttpException(
        'Esa asociación ya está vinculada a otro cliente',
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.client.update({
      where: { id: clientId },
      data: { tenantId: tenant.id, tenantCode: tenant.code },
    });
  }

  async unassignTenant(clientId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    return this.prisma.client.update({
      where: { id: clientId },
      data: { tenantId: null, tenantCode: null },
    });
  }

  // ---------- available tenants for assignment ----------

  async listAvailableTenants() {
    const tenants = await this.loadTenants();
    const taken = await this.prisma.client.findMany({
      where: { tenantId: { not: null } },
      select: { tenantId: true },
    });
    const used = new Set(taken.map((c) => c.tenantId));
    return tenants
      .filter((t) => !used.has(t.id))
      .map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        active: t.active,
      }));
  }

  // ---------- sync ----------

  async syncFromTenants() {
    const tenants = await this.loadTenants();
    const existing = await this.prisma.client.findMany({
      where: { tenantId: { not: null } },
      select: { tenantId: true },
    });
    const have = new Set(existing.map((c) => c.tenantId));

    let created = 0;
    for (const t of tenants) {
      if (have.has(t.id)) continue;
      const plan = await this.loadPlan(t.id).catch(() => null);
      const stage = this.deriveStage(plan, t.active);
      await this.prisma.client.create({
        data: {
          tenantId: t.id,
          tenantCode: t.code,
          name: t.name ?? t.code,
          stage,
        },
      });
      created++;
    }
    return { created, total: tenants.length };
  }

  // ---------- comments ----------

  async addComment(clientId: string, content: string, author?: string | null) {
    const c = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!c) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    if (!content?.trim()) {
      throw new HttpException(
        'El comentario no puede estar vacío',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.prisma.clientComment.create({
      data: {
        clientId,
        content: content.trim(),
        author: author ?? null,
      },
    });
  }

  async deleteComment(clientId: string, commentId: string) {
    const cm = await this.prisma.clientComment.findUnique({
      where: { id: commentId },
    });
    if (!cm || cm.clientId !== clientId) {
      throw new HttpException('Comentario no encontrado', HttpStatus.NOT_FOUND);
    }
    await this.prisma.clientComment.delete({ where: { id: commentId } });
    return { success: true };
  }

  // ---------- contacts ----------

  async listContacts(clientId: string) {
    const c = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!c) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    return this.prisma.clientContact.findMany({
      where: { clientId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async addContact(clientId: string, data: ContactInput) {
    const c = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!c) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    if (!data.name?.trim()) {
      throw new HttpException('El nombre es requerido', HttpStatus.BAD_REQUEST);
    }
    if (data.isPrimary) {
      await this.prisma.clientContact.updateMany({
        where: { clientId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return this.prisma.clientContact.create({
      data: {
        clientId,
        kind: data.kind ?? ContactKind.CONTACT,
        name: data.name.trim(),
        role: data.role?.trim() || null,
        email: data.email?.trim() || null,
        phone: data.phone?.trim() || null,
        notes: data.notes?.trim() || null,
        isPrimary: Boolean(data.isPrimary),
      },
    });
  }

  async updateContact(clientId: string, contactId: string, data: ContactUpdateInput) {
    const existing = await this.prisma.clientContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.clientId !== clientId) {
      throw new HttpException('Contacto no encontrado', HttpStatus.NOT_FOUND);
    }
    if (data.isPrimary) {
      await this.prisma.clientContact.updateMany({
        where: { clientId, isPrimary: true, NOT: { id: contactId } },
        data: { isPrimary: false },
      });
    }
    return this.prisma.clientContact.update({
      where: { id: contactId },
      data: {
        kind: data.kind ?? undefined,
        name: data.name?.trim() ?? undefined,
        role: data.role === undefined ? undefined : (data.role?.trim() || null),
        email: data.email === undefined ? undefined : (data.email?.trim() || null),
        phone: data.phone === undefined ? undefined : (data.phone?.trim() || null),
        notes: data.notes === undefined ? undefined : (data.notes?.trim() || null),
        isPrimary: data.isPrimary ?? undefined,
      },
    });
  }

  async deleteContact(clientId: string, contactId: string) {
    const existing = await this.prisma.clientContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.clientId !== clientId) {
      throw new HttpException('Contacto no encontrado', HttpStatus.NOT_FOUND);
    }
    await this.prisma.clientContact.delete({ where: { id: contactId } });
    return { success: true };
  }

  // ---------- attributes ----------

  async listAttributes(clientId: string) {
    const c = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!c) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    return this.prisma.clientAttribute.findMany({
      where: { clientId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async addAttribute(clientId: string, data: AttributeInput) {
    const c = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!c) {
      throw new HttpException('Cliente no encontrado', HttpStatus.NOT_FOUND);
    }
    const key = data.key?.trim();
    if (!key) {
      throw new HttpException('La clave es requerida', HttpStatus.BAD_REQUEST);
    }
    const dup = await this.prisma.clientAttribute.findUnique({
      where: { clientId_key: { clientId, key } },
    });
    if (dup) {
      throw new HttpException(
        'Ya existe un atributo con esa clave',
        HttpStatus.CONFLICT,
      );
    }
    const last = await this.prisma.clientAttribute.findFirst({
      where: { clientId },
      orderBy: { position: 'desc' },
    });
    return this.prisma.clientAttribute.create({
      data: {
        clientId,
        key,
        value: data.value ?? '',
        type: data.type ?? AttributeType.TEXT,
        position: data.position ?? ((last?.position ?? -1) + 1),
      },
    });
  }

  async updateAttribute(
    clientId: string,
    attributeId: string,
    data: AttributeUpdateInput,
  ) {
    const existing = await this.prisma.clientAttribute.findUnique({
      where: { id: attributeId },
    });
    if (!existing || existing.clientId !== clientId) {
      throw new HttpException('Atributo no encontrado', HttpStatus.NOT_FOUND);
    }
    if (data.key !== undefined) {
      const newKey = data.key.trim();
      if (!newKey) {
        throw new HttpException('La clave es requerida', HttpStatus.BAD_REQUEST);
      }
      if (newKey !== existing.key) {
        const dup = await this.prisma.clientAttribute.findUnique({
          where: { clientId_key: { clientId, key: newKey } },
        });
        if (dup) {
          throw new HttpException(
            'Ya existe un atributo con esa clave',
            HttpStatus.CONFLICT,
          );
        }
      }
    }
    return this.prisma.clientAttribute.update({
      where: { id: attributeId },
      data: {
        key: data.key?.trim() ?? undefined,
        value: data.value ?? undefined,
        type: data.type ?? undefined,
        position: data.position ?? undefined,
      },
    });
  }

  async deleteAttribute(clientId: string, attributeId: string) {
    const existing = await this.prisma.clientAttribute.findUnique({
      where: { id: attributeId },
    });
    if (!existing || existing.clientId !== clientId) {
      throw new HttpException('Atributo no encontrado', HttpStatus.NOT_FOUND);
    }
    await this.prisma.clientAttribute.delete({ where: { id: attributeId } });
    return { success: true };
  }
}
