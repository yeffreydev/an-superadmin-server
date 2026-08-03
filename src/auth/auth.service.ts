import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../config';

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  async login(password: string): Promise<{ token: string }> {
    if (password !== appConfig.ADMIN_PASSWORD) {
      throw new UnauthorizedException('Invalid password');
    }

    const token = this.jwtService.sign({ role: 'superadmin' });
    return { token };
  }
}
