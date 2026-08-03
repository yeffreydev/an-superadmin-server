import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { appConfig } from '../config';

export interface SocioData {
  id: string;
  name: string;
  lastname: string;
  dni: string;
  phone: string;
  email: string | null;
}

export interface SocioFinancialSummary {
  socio: SocioData;
  unicaName: string;
  loans: {
    id: string;
    amount: number;
    balance: number;
    status: string;
    interestRate: number;
    type: string;
    date: string;
    installments: {
      number: number;
      payment: number;
      interest: number;
      balance: number;
      paid: boolean;
      date: string;
    }[];
  }[];
  deposits: { id: string; amount: number; date: string }[];
  totalDeposits: number;
  stocks: {
    id: string;
    quantity: number;
    price: number;
    stockName: string;
    date: string;
  }[];
  totalStocksValue: number;
  creditApplications: {
    id: string;
    amount: number;
    purpose: string | null;
    status: string;
    createdAt: string;
  }[];
}

interface UserUnicaMatch {
  phone: string;
  tenantUuid: string;
  tenantCode: string;
  unicaName: string;
}

@Injectable()
export class TenantQueryService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantQueryService.name);
  private acasPool: Pool;
  private qipiPool: Pool;

  constructor() {
    this.acasPool = new Pool({ connectionString: appConfig.ACAS_DATABASE_URL });
    this.qipiPool = new Pool({ connectionString: appConfig.QIPI_DATABASE_URL });
  }

  async onModuleDestroy() {
    await this.acasPool.end();
    await this.qipiPool.end();
  }

  /**
   * QIPI side: find AppUser by phone → their active Unica → its tenant code.
   * ACAS side: resolve that code to a tenant UUID.
   */
  async findUserUnica(phone: string): Promise<UserUnicaMatch | null> {
    const cleanPhone = phone.replace(/\D/g, '');
    const last9 = cleanPhone.slice(-9);

    const userRes = await this.qipiPool.query(
      `SELECT au.id, au.phone
         FROM "AppUser" au
         WHERE au.phone LIKE $1 OR au.phone LIKE $2
         LIMIT 1`,
      [`%${last9}`, cleanPhone],
    );
    if (userRes.rows.length === 0) return null;
    const appUser = userRes.rows[0];

    const unicaRes = await this.qipiPool.query(
      `SELECT u.id, u.name, u."tenantId"
         FROM "Unica" u
         JOIN "UserUnica" uu ON u.id = uu."unicaId"
         WHERE uu."appUserId" = $1 AND uu.status = 'active'
         LIMIT 1`,
      [appUser.id],
    );
    if (unicaRes.rows.length === 0) return null;
    const unica = unicaRes.rows[0];

    const tRes = await this.acasPool.query(
      `SELECT id, code FROM tenants WHERE code = $1`,
      [unica.tenantId],
    );
    if (tRes.rows.length === 0) return null;

    return {
      phone: appUser.phone,
      tenantUuid: tRes.rows[0].id,
      tenantCode: tRes.rows[0].code,
      unicaName: unica.name,
    };
  }

  async getFullSocioSummary(phone: string): Promise<SocioFinancialSummary | null> {
    const match = await this.findUserUnica(phone);
    if (!match) return null;

    const cleanPhone = phone.replace(/\D/g, '');
    const last9 = cleanPhone.slice(-9);

    const userRes = await this.acasPool.query(
      `SELECT id, name, lastname, dni, phone, email
         FROM "User"
        WHERE ("phone" LIKE $1 OR "phone" LIKE $2)
          AND "deletedAt" IS NULL
          AND "tenantId" = $3
        LIMIT 1`,
      [`%${last9}`, cleanPhone, match.tenantUuid],
    );
    if (userRes.rows.length === 0) return null;
    const socio: SocioData = userRes.rows[0];

    const [loansData, depositsData, stocksData, creditAppsData] = await Promise.all([
      this.queryLoans(socio.id, match.tenantUuid),
      this.queryDeposits(socio.id, match.tenantUuid),
      this.queryStocks(socio.id, match.tenantUuid),
      this.queryCreditApplications(socio.id, match.tenantUuid),
    ]);

    return {
      socio,
      unicaName: match.unicaName,
      ...loansData,
      ...depositsData,
      ...stocksData,
      creditApplications: creditAppsData,
    };
  }

  private async queryLoans(userId: string, tenantId: string) {
    const loansRes = await this.acasPool.query(
      `SELECT l.id, l.amount, l.balance, l.status, l."interestRate", l.date,
              lt.name AS "typeName"
         FROM "Loan" l
         LEFT JOIN "LoanType" lt ON l."loanTypeId" = lt.id
        WHERE l."userId" = $1 AND l."deletedAt" IS NULL AND l."tenantId" = $2
        ORDER BY l.date DESC`,
      [userId, tenantId],
    );

    const loans = [];
    for (const loan of loansRes.rows) {
      const instRes = await this.acasPool.query(
        `SELECT installment_number, payment, interest, balance, paid, date
           FROM "LoanInstallment"
          WHERE "loanId" = $1 AND "deletedAt" IS NULL AND "tenantId" = $2
          ORDER BY installment_number ASC`,
        [loan.id, tenantId],
      );

      loans.push({
        id: loan.id,
        amount: parseFloat(loan.amount),
        balance: parseFloat(loan.balance ?? '0'),
        status: loan.status,
        interestRate: parseFloat(loan.interestRate),
        type: loan.typeName ?? 'N/A',
        date: loan.date?.toISOString().split('T')[0] ?? '',
        installments: instRes.rows.map((i) => ({
          number: i.installment_number ?? 0,
          payment: parseFloat(i.payment),
          interest: parseFloat(i.interest),
          balance: parseFloat(i.balance ?? '0'),
          paid: i.paid,
          date: i.date?.toISOString().split('T')[0] ?? '',
        })),
      });
    }
    return { loans };
  }

  private async queryDeposits(userId: string, tenantId: string) {
    const depositsRes = await this.acasPool.query(
      `SELECT id, amount, date
         FROM "Deposits"
        WHERE "userId" = $1 AND "deletedAt" IS NULL AND "tenantId" = $2
        ORDER BY date DESC LIMIT 20`,
      [userId, tenantId],
    );

    const totalRes = await this.acasPool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM "Deposits"
        WHERE "userId" = $1 AND "deletedAt" IS NULL AND "tenantId" = $2`,
      [userId, tenantId],
    );

    return {
      deposits: depositsRes.rows.map((d) => ({
        id: d.id,
        amount: parseFloat(d.amount),
        date: d.date?.toISOString().split('T')[0] ?? '',
      })),
      totalDeposits: parseFloat(totalRes.rows[0].total),
    };
  }

  private async queryStocks(userId: string, tenantId: string) {
    const stocksRes = await this.acasPool.query(
      `SELECT us.id, us.quantity, us.price, us.date, s.name AS "stockName"
         FROM "UserStock" us
         LEFT JOIN "Stock" s ON us."stockId" = s.id
        WHERE us."userId" = $1 AND us."deletedAt" IS NULL AND us."tenantId" = $2
        ORDER BY us.date DESC`,
      [userId, tenantId],
    );

    let totalStocksValue = 0;
    const stocks = stocksRes.rows.map((s) => {
      const qty = parseInt(s.quantity);
      const price = parseFloat(s.price);
      totalStocksValue += qty * price;
      return {
        id: s.id,
        quantity: qty,
        price,
        stockName: s.stockName ?? 'N/A',
        date: s.date?.toISOString().split('T')[0] ?? '',
      };
    });

    return { stocks, totalStocksValue };
  }

  private async queryCreditApplications(userId: string, tenantId: string) {
    const res = await this.acasPool.query(
      `SELECT id, amount, purpose, status, "createdAt"
         FROM "CreditApplication"
        WHERE "userId" = $1 AND "deletedAt" IS NULL AND "tenantId" = $2
        ORDER BY "createdAt" DESC LIMIT 10`,
      [userId, tenantId],
    );

    return res.rows.map((a) => ({
      id: a.id,
      amount: parseFloat(a.amount),
      purpose: a.purpose,
      status: a.status,
      createdAt: a.createdAt?.toISOString().split('T')[0] ?? '',
    }));
  }

  buildContextForAI(summary: SocioFinancialSummary): string {
    const { socio, unicaName, loans, deposits, totalDeposits, stocks, totalStocksValue, creditApplications } = summary;

    let ctx = `SOCIO: ${socio.name} ${socio.lastname} | DNI: ${socio.dni} | UNICA: ${unicaName}\n`;

    ctx += `\nPRESTAMOS (${loans.length}):\n`;
    if (loans.length === 0) {
      ctx += `Sin prestamos activos.\n`;
    } else {
      for (const loan of loans) {
        ctx += `• ${loan.type}: S/${loan.amount.toFixed(2)} | Saldo: S/${loan.balance.toFixed(2)} | ${loan.status} | Tasa: ${(loan.interestRate * 100).toFixed(1)}%\n`;
        const pending = loan.installments.filter((i) => !i.paid);
        if (pending.length > 0) {
          ctx += `  Cuotas pendientes: ${pending.length}\n`;
          for (const inst of pending.slice(0, 3)) {
            ctx += `  - #${inst.number}: S/${inst.payment.toFixed(2)} (vence ${inst.date})\n`;
          }
          if (pending.length > 3) ctx += `  ... +${pending.length - 3} mas\n`;
        }
      }
    }

    ctx += `\nAHORROS: S/${totalDeposits.toFixed(2)} total`;
    if (deposits.length > 0) {
      ctx += ` (ultimo: S/${deposits[0].amount.toFixed(2)} el ${deposits[0].date})`;
    }
    ctx += `\n`;

    ctx += `ACCIONES: S/${totalStocksValue.toFixed(2)} total`;
    if (stocks.length > 0) {
      ctx += ` (${stocks.map((s) => `${s.quantity}x ${s.stockName}`).join(', ')})`;
    }
    ctx += `\n`;

    if (creditApplications.length > 0) {
      ctx += `\nSOLICITUDES: ${creditApplications.map((a) => `S/${a.amount.toFixed(2)} - ${a.status}`).join(' | ')}\n`;
    }

    return ctx;
  }
}
