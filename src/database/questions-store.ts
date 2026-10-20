import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import type { QuestionData, QuestionType, StoredQuestion } from '../questions/question.types';
import { QuestionEntity } from './question.entity';

export const QUESTIONS_STORE = Symbol('QUESTIONS_STORE');

export interface QuestionsStore {
  create(question: QuestionData): Promise<StoredQuestion>;
  /** Newest first, optionally of one type. */
  list(type?: QuestionType, limit?: number): Promise<StoredQuestion[]>;
  count(): Promise<Record<string, number>>;
  remove(id: string): Promise<boolean>;
}

export class PostgresQuestionsStore implements QuestionsStore {
  constructor(private readonly repo: Repository<QuestionEntity>) {}

  create(question: QuestionData) {
    return this.repo.save(this.repo.create(question));
  }

  list(type?: QuestionType, limit = 100) {
    return this.repo.find({
      where: type ? { type } : {},
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async count() {
    const rows = await this.repo
      .createQueryBuilder('q')
      .select('q.type', 'type')
      .addSelect('COUNT(*)', 'n')
      .groupBy('q.type')
      .getRawMany<{ type: string; n: string }>();
    return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
  }

  async remove(id: string) {
    const result = await this.repo.delete(id);
    return (result.affected ?? 0) > 0;
  }
}

/** Used when no DATABASE_URL is set; lost on restart. */
export class MemoryQuestionsStore implements QuestionsStore {
  private readonly items: StoredQuestion[] = [];

  async create(question: QuestionData) {
    const stored = { ...question, id: randomUUID(), createdAt: new Date() };
    this.items.push(stored);
    return stored;
  }

  async list(type?: QuestionType, limit = 100) {
    return this.items
      .filter((q) => !type || q.type === type)
      .reverse()
      .slice(0, limit);
  }

  async count() {
    const out: Record<string, number> = {};
    for (const q of this.items) out[q.type] = (out[q.type] ?? 0) + 1;
    return out;
  }

  async remove(id: string) {
    const i = this.items.findIndex((q) => q.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
}
