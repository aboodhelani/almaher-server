import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Dashboard endpoints need the `x-admin-key` header to match ADMIN_KEY.
 * Development default: `almaher-admin` — set a real key before deploying.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = process.env.ADMIN_KEY ?? 'almaher-admin';
    if (req.header('x-admin-key') !== expected) {
      throw new UnauthorizedException('invalid_admin_key');
    }
    return true;
  }
}
