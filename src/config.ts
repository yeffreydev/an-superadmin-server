import 'dotenv/config';

export const appConfig = {
  PORT: parseInt(process.env.PORT || '4002', 10),
  JWT_SECRET: process.env.JWT_SECRET || 'superadmin-jwt-secret-2024',
  // --- Panel accounts -------------------------------------------------------
  // Whoever signs in with this email (by password or Google) is the superadmin;
  // everybody else is a plain admin that only sees their own associations.
  SUPERADMIN_EMAIL: (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase(),
  // Second key: asked again at /superadmin to unlock the superadmin area.
  SUPERADMIN_PASSWORD:
    process.env.SUPERADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'superadmin123',
  // First key of the superadmin account. Only used to bootstrap the row on
  // boot; defaults to the second key when not set (change it in production).
  SUPERADMIN_LOGIN_PASSWORD:
    process.env.SUPERADMIN_LOGIN_PASSWORD ||
    process.env.SUPERADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    'superadmin123',
  // How long an unlocked superadmin session lasts before the second key is
  // asked again.
  SUPERADMIN_UNLOCK_TTL: process.env.SUPERADMIN_UNLOCK_TTL || '2h',
  // Google OAuth client id (the same one the frontend renders the button with).
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  // Set to 'true' to stop new self-service signups.
  SIGNUP_DISABLED: process.env.SIGNUP_DISABLED === 'true',
  // A tenant `code` is the hostname the association is served on (see
  // server/src/tenant/tenant.middleware.ts), so codes generated for a new
  // association are subdomains of this base domain.
  ASSOCIATION_DOMAIN: process.env.ASSOCIATION_DOMAIN || 'aquinace.com',
  // HTTP API of `server` (the unicas backend). Used to open an onboarding
  // session on the association right after it is created.
  ACAS_SERVER_URL: process.env.ACAS_SERVER_URL || 'http://localhost:4000',
  // Where unica-system is served. Empty = each association lives on its own
  // host (https://<code>), which is the production setup; set it in dev where
  // every tenant is served from the same localhost origin.
  UNICA_APP_URL: process.env.UNICA_APP_URL || '',
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
