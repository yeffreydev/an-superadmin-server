import 'dotenv/config';

export const appConfig = {
  PORT: parseInt(process.env.PORT || '4002', 10),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'superadmin123',
  JWT_SECRET: process.env.JWT_SECRET || 'superadmin-jwt-secret-2024',
  // Shared ACAS database (formerly MASTER_DATABASE_URL). Holds the `tenants`
  // table plus every row-level-multitenant table for the unicas system.
  ACAS_DATABASE_URL:
    process.env.ACAS_DATABASE_URL || process.env.MASTER_DATABASE_URL,
  QIPI_DATABASE_URL: process.env.QIPI_DATABASE_URL,
  // Base URL of qipi-server-nest's HTTP API (not the DB). Used to register a
  // newly created tenant as a "Unica" there so app invitations can flow.
  QIPI_SERVER_URL: process.env.QIPI_SERVER_URL || 'https://appserver.aquinace.com',
  PIXEL_BASE_URL: process.env.PIXEL_BASE_URL || 'http://localhost:4002',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5174',
  // Agent AI
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  // Agent Botia
  BOTIA_WEBHOOK_URL: process.env.BOTIA_WEBHOOK_URL,
  BOTIA_API_KEY: process.env.BOTIA_API_KEY,
};
