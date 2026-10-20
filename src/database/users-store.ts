import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { UserEntity } from './user.entity';

export const USERS_STORE = Symbol('USERS_STORE');

export type NewUser = Pick<
  UserEntity,
  'email' | 'displayName' | 'passwordHash'
>;

export interface UsersStore {
  create(user: NewUser): Promise<UserEntity>;
  byEmail(email: string): Promise<UserEntity | null>;
  byId(id: string): Promise<UserEntity | null>;
  count(): Promise<number>;
  delete(id: string): Promise<void>;
}

export class PostgresUsersStore implements UsersStore {
  constructor(private readonly repo: Repository<UserEntity>) {}

  create(user: NewUser) {
    return this.repo.save(this.repo.create(user));
  }

  byEmail(email: string) {
    return this.repo.findOne({ where: { email } });
  }

  byId(id: string) {
    return this.repo.findOne({ where: { id } });
  }

  count() {
    return this.repo.count();
  }

  async delete(id: string) {
    await this.repo.delete({ id });
  }
}

/** Used when no DATABASE_URL is set; lost on restart. */
export class MemoryUsersStore implements UsersStore {
  private readonly users: UserEntity[] = [];

  async create(user: NewUser) {
    const created = { ...user, id: randomUUID(), createdAt: new Date() };
    this.users.push(created);
    return created;
  }

  async byEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }

  async byId(id: string) {
    return this.users.find((u) => u.id === id) ?? null;
  }

  async count() {
    return this.users.length;
  }

  async delete(id: string) {
    const i = this.users.findIndex((u) => u.id === id);
    if (i >= 0) this.users.splice(i, 1);
  }
}
