import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { appConfig } from '../config';

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | null;
  avatar: string | null;
}

interface TokenInfo {
  aud: string;
  sub: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  exp: string;
}

/**
 * Verifies Google ID tokens (the `credential` returned by Google Identity
 * Services in the browser) against Google's tokeninfo endpoint, so no extra
 * dependency and no client secret are needed — the frontend never sees a
 * password and the backend never trusts the browser's claims.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);

  async verify(credential: string): Promise<GoogleProfile> {
    if (!credential) {
      throw new UnauthorizedException('Falta el token de Google');
    }
    if (!appConfig.GOOGLE_CLIENT_ID) {
      throw new UnauthorizedException(
        'Login con Google no configurado en el servidor (GOOGLE_CLIENT_ID)',
      );
    }

    let info: TokenInfo;
    try {
      const res = await axios.get<TokenInfo>(
        'https://oauth2.googleapis.com/tokeninfo',
        { params: { id_token: credential }, timeout: 10000 },
      );
      info = res.data;
    } catch (e: any) {
      this.logger.warn(`Google tokeninfo rejected a credential: ${e.message}`);
      throw new UnauthorizedException('Token de Google inválido');
    }

    // The audience check is what ties the token to *this* app; without it any
    // valid Google token from any app would be accepted.
    const allowed = appConfig.GOOGLE_CLIENT_ID.split(',').map((s) => s.trim());
    if (!allowed.includes(info.aud)) {
      throw new UnauthorizedException('Token de Google emitido para otra aplicación');
    }
    if (!info.email) {
      throw new UnauthorizedException('La cuenta de Google no expone un correo');
    }
    const verified = info.email_verified === true || info.email_verified === 'true';
    if (!verified) {
      throw new UnauthorizedException('El correo de Google no está verificado');
    }
    if (Number(info.exp) * 1000 < Date.now()) {
      throw new UnauthorizedException('El token de Google expiró');
    }

    return {
      googleId: info.sub,
      email: info.email.trim().toLowerCase(),
      name: info.name ?? null,
      avatar: info.picture ?? null,
    };
  }
}
