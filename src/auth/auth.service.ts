import { Inject, Injectable } from '@nestjs/common';
import { RESULTS_STORE } from '../database/results-store';
import type { ResultsStore, StoredResult } from '../database/results-store';
import { USERS_STORE } from '../database/users-store';
import type { UsersStore } from '../database/users-store';
import type { UserEntity } from '../database/user.entity';
import { hashPassword, verifyPassword } from './password';
import { signToken, verifyToken } from './token';

/** An auth error with a code clients translate (like MatchError). */
/** Shown in past results in place of a deleted account's name. */
export const DELETED_PLAYER = 'لاعب محذوف';

export class AuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

export interface PlayerStats {
  matches: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
}

export interface LeaderboardRow extends PlayerStats {
  userId: string;
  name: string;
  rank: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class AuthService {
  constructor(
    @Inject(USERS_STORE) private readonly users: UsersStore,
    @Inject(RESULTS_STORE) private readonly results: ResultsStore,
  ) {}

  async register(email: unknown, password: unknown, name: unknown) {
    const e = String(email ?? '').trim().toLowerCase();
    const n = String(name ?? '').trim().slice(0, 40);
    const p = String(password ?? '');
    if (!EMAIL.test(e)) throw new AuthError('invalid_email');
    if (p.length < 6) throw new AuthError('weak_password');
    if (n.length < 2) throw new AuthError('name_required');
    if (await this.users.byEmail(e)) throw new AuthError('email_taken');
    const user = await this.users.create({
      email: e,
      displayName: n,
      passwordHash: await hashPassword(p),
    });
    return this.session(user);
  }

  async login(email: unknown, password: unknown) {
    const user = await this.users.byEmail(String(email ?? '').trim().toLowerCase());
    if (!user || !(await verifyPassword(String(password ?? ''), user.passwordHash))) {
      throw new AuthError('invalid_credentials');
    }
    return this.session(user);
  }

  /**
   * Deletes the account behind [token] once its password is confirmed; its
   * past matches stay in the history without its id or name.
   */
  async deleteAccount(token: unknown, password: unknown) {
    const id = verifyToken(token);
    const user = id ? await this.users.byId(id) : null;
    if (!user) throw new AuthError('unauthorized');
    if (!(await verifyPassword(String(password ?? ''), user.passwordHash))) {
      throw new AuthError('invalid_credentials');
    }
    await this.results.forget(user.id, DELETED_PLAYER);
    await this.users.delete(user.id);
  }

  /** The account behind a token, or null. */
  async fromToken(token: unknown): Promise<PublicUser | null> {
    const id = verifyToken(token);
    const user = id ? await this.users.byId(id) : null;
    return user ? this.public(user) : null;
  }

  async stats(userId: string): Promise<PlayerStats & { recent: RecentMatch[] }> {
    const results = await this.results.forUser(userId);
    const stats = emptyStats();
    for (const r of results) addResult(stats, r, userId);
    return { ...stats, recent: results.slice(0, 10).map((r) => recent(r, userId)) };
  }

  /** Accounts ranked by wins, then points, then fewest matches. */
  async leaderboard(limit = 50): Promise<LeaderboardRow[]> {
    const byUser = new Map<string, PlayerStats & { name: string }>();
    for (const r of await this.results.withAccounts()) {
      for (const [id, name] of [
        [r.player1UserId, r.player1Name],
        [r.player2UserId, r.player2Name],
      ] as const) {
        if (!id) continue;
        const row = byUser.get(id) ?? { ...emptyStats(), name };
        addResult(row, r, id);
        byUser.set(id, row);
      }
    }
    return [...byUser.entries()]
      .map(([userId, s]) => ({ userId, ...s }))
      .sort((a, b) => b.wins - a.wins || b.points - a.points || a.matches - b.matches)
      .slice(0, limit)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }

  private session(user: UserEntity) {
    return { token: signToken(user.id), user: this.public(user) };
  }

  private public(user: UserEntity): PublicUser {
    return { id: user.id, email: user.email, name: user.displayName };
  }
}

export interface RecentMatch {
  code: string;
  opponent: string;
  myScore: number;
  opponentScore: number;
  result: 'win' | 'draw' | 'loss';
  finishedAt: Date;
}

const emptyStats = (): PlayerStats => ({ matches: 0, wins: 0, draws: 0, losses: 0, points: 0 });

function seatOf(r: StoredResult, userId: string): 'player1' | 'player2' {
  return r.player1UserId === userId ? 'player1' : 'player2';
}

function addResult(s: PlayerStats, r: StoredResult, userId: string) {
  const seat = seatOf(r, userId);
  s.matches += 1;
  s.points += seat === 'player1' ? r.player1Score : r.player2Score;
  if (r.winner === 'draw') s.draws += 1;
  else if (r.winner === seat) s.wins += 1;
  else s.losses += 1;
}

function recent(r: StoredResult, userId: string): RecentMatch {
  const mine = seatOf(r, userId) === 'player1';
  return {
    code: r.code,
    opponent: mine ? r.player2Name : r.player1Name,
    myScore: mine ? r.player1Score : r.player2Score,
    opponentScore: mine ? r.player2Score : r.player1Score,
    result: r.winner === 'draw' ? 'draw' : r.winner === seatOf(r, userId) ? 'win' : 'loss',
    finishedAt: r.finishedAt,
  };
}
