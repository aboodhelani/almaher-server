import { Repository } from 'typeorm';
import { MatchResultEntity } from './match-result.entity';

export const RESULTS_STORE = Symbol('RESULTS_STORE');

export type MatchResult = Omit<MatchResultEntity, 'id' | 'finishedAt'>;

export type StoredResult = MatchResult & { finishedAt: Date };

export interface ResultsStore {
  save(result: MatchResult): Promise<void>;

  /** Newest first. */
  list(limit: number): Promise<StoredResult[]>;

  /** Every result an account played in, newest first. */
  forUser(userId: string): Promise<StoredResult[]>;

  /** Every result that has an account in it (for the leaderboard). */
  withAccounts(): Promise<StoredResult[]>;

  /** Removes a deleted account from its results (id and name). */
  forget(userId: string, placeholderName: string): Promise<void>;
}

export class PostgresResultsStore implements ResultsStore {
  constructor(private readonly repo: Repository<MatchResultEntity>) {}

  async save(result: MatchResult) {
    await this.repo.save(this.repo.create(result));
  }

  async list(limit: number) {
    return this.repo.find({ order: { finishedAt: 'DESC' }, take: limit });
  }

  forUser(userId: string) {
    return this.repo.find({
      where: [{ player1UserId: userId }, { player2UserId: userId }],
      order: { finishedAt: 'DESC' },
    });
  }

  withAccounts() {
    return this.repo
      .createQueryBuilder('r')
      .where('r.player1UserId IS NOT NULL OR r.player2UserId IS NOT NULL')
      .getMany();
  }

  async forget(userId: string, placeholderName: string) {
    await this.repo.update(
      { player1UserId: userId },
      { player1UserId: null, player1Name: placeholderName },
    );
    await this.repo.update(
      { player2UserId: userId },
      { player2UserId: null, player2Name: placeholderName },
    );
  }
}

/** Used when no DATABASE_URL is set, so the game runs without Postgres. */
export class MemoryResultsStore implements ResultsStore {
  readonly results: StoredResult[] = [];

  async save(result: MatchResult) {
    this.results.push({ ...result, finishedAt: new Date() });
  }

  async list(limit: number) {
    return [...this.results].reverse().slice(0, limit);
  }

  async forUser(userId: string) {
    return [...this.results]
      .reverse()
      .filter((r) => r.player1UserId === userId || r.player2UserId === userId);
  }

  async withAccounts() {
    return this.results.filter((r) => r.player1UserId || r.player2UserId);
  }

  async forget(userId: string, placeholderName: string) {
    for (const r of this.results) {
      if (r.player1UserId === userId) {
        r.player1UserId = null;
        r.player1Name = placeholderName;
      }
      if (r.player2UserId === userId) {
        r.player2UserId = null;
        r.player2Name = placeholderName;
      }
    }
  }
}
