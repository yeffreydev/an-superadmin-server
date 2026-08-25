# Cuentas del panel (admin + superadmin)

El panel dejó de ser "una sola clave para todo". Ahora hay dos niveles:

| Nivel | Quién | Cómo entra | Qué ve |
|---|---|---|---|
| **Admin** | cualquier creador | correo + clave, o Google | solo las asociaciones que él creó |
| **Superadmin** | la cuenta cuyo correo es `SUPERADMIN_EMAIL` | lo mismo **+ segunda clave** en `/superadmin` | todo (tenants, clientes, planes, pixels, app) |

## Doble clave

1. **Primera clave** — `POST /auth/login` (o `POST /auth/google`). Devuelve un JWT de 24 h.
   Ese token abre el panel de asociaciones y nada más.
2. **Segunda clave** — `POST /auth/superadmin/unlock` con `SUPERADMIN_PASSWORD`.
   Solo la acepta la cuenta con rol `SUPERADMIN`. Devuelve un JWT corto
   (`SUPERADMIN_UNLOCK_TTL`, por defecto 2 h) con el flag `sa: true`.

`SuperadminGuard` exige rol `SUPERADMIN` **y** el flag `sa`. Si falta el flag
responde `403 SUPERADMIN_LOCKED`, y el frontend manda de vuelta a `/superadmin`
a pedir la segunda clave (sin cerrar la sesión).

El frontend guarda los dos tokens por separado (`panel-token` y
`panel-sa-token`) y usa cada uno con su instancia de axios, así una sesión
normal no puede tocar rutas de superadmin ni escribiendo la URL a mano.

## Variables de entorno

```env
SUPERADMIN_EMAIL=tucorreo@gmail.com     # quién es el superadmin
SUPERADMIN_LOGIN_PASSWORD=...           # primera clave (solo para crear la cuenta la 1ª vez)
SUPERADMIN_PASSWORD=...                 # segunda clave, la de /superadmin
SUPERADMIN_UNLOCK_TTL=2h
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
SIGNUP_DISABLED=false                   # true cierra el registro público
ASSOCIATION_DOMAIN=aquinace.com         # las asociaciones nuevas nacen como <slug>.aquinace.com
```

Al arrancar, el servidor crea (o corrige) la cuenta de `SUPERADMIN_EMAIL` con
rol `SUPERADMIN`. El correo del env es la única fuente de verdad: si otra cuenta
tenía el rol y ya no coincide con el env, lo pierde en su siguiente login.

`SUPERADMIN_LOGIN_PASSWORD` solo se usa para sembrar la cuenta la primera vez.
Después se cambia con `PUT /auth/me` (o se entra con Google) y cambiar el env ya
no la afecta.

## Google

El navegador obtiene un ID token con Google Identity Services y lo manda a
`POST /auth/google`. El backend lo verifica contra
`https://oauth2.googleapis.com/tokeninfo`, comprueba que el `aud` sea
`GOOGLE_CLIENT_ID` y que el correo esté verificado. Si el correo coincide con
`SUPERADMIN_EMAIL`, esa sesión también podrá pedir la segunda clave.

Hay que registrar el origen del panel (`https://panel.aquinace.com` y
`http://localhost:5174`) como *Authorized JavaScript origin* del client id en la
consola de Google.

## Rutas

Admin (token de sesión):

```
GET    /associations                      mis asociaciones
POST   /associations                      crear (name, code opcional)
GET    /associations/:id                  detalle (solo si es mía)
PUT    /associations/:id                  renombrar
GET    /associations/:id/stats|users|invitations|backup
POST   /associations/:id/invitations|connect-app
PUT    /associations/:id/users/:userId    credenciales del usuario
DELETE /associations/:id/invitations/:invId
```

Superadmin (token desbloqueado): `/tenants`, `/clients`, `/plans`,
`/pixels`, `/app/*`, `/dashboard`, `/associations/owners`, `/associations/all`.

La asociación en sí vive en la base ACAS (tabla `tenants` + su semilla); en la
base del panel solo se guarda el vínculo cuenta → tenant (`Association`), así el
esquema de ACAS no cambia.
