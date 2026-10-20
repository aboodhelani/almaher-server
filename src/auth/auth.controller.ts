import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthError, AuthService } from './auth.service';

/** Accounts: register, log in, the signed-in player's profile, the leaderboard. */
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/register')
  register(@Body() body: { email?: string; password?: string; name?: string }) {
    return this.run(() =>
      this.auth.register(body?.email, body?.password, body?.name),
    );
  }

  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: { email?: string; password?: string }) {
    return this.run(() => this.auth.login(body?.email, body?.password));
  }

  /** The signed-in account with its stats and recent matches. */
  @Get('auth/me')
  async me(@Headers('authorization') header?: string) {
    const user = await this.auth.fromToken(header?.replace(/^Bearer\s+/i, ''));
    if (!user) throw new UnauthorizedException('unauthorized');
    return { user, stats: await this.auth.stats(user.id) };
  }

  /** Deletes the signed-in account (the password confirms it). */
  @Delete('auth/me')
  @HttpCode(204)
  async deleteMe(
    @Headers('authorization') header?: string,
    @Body() body?: { password?: string },
  ) {
    try {
      await this.auth.deleteAccount(
        header?.replace(/^Bearer\s+/i, ''),
        body?.password,
      );
    } catch (e) {
      if (e instanceof AuthError && e.code === 'unauthorized') {
        throw new UnauthorizedException('unauthorized');
      }
      if (e instanceof AuthError) throw new BadRequestException(e.code);
      throw e;
    }
  }

  @Get('leaderboard')
  leaderboard() {
    return this.auth.leaderboard();
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (e) {
      if (e instanceof AuthError) throw new BadRequestException(e.code);
      throw e;
    }
  }
}
