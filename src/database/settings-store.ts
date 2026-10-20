import { Repository } from 'typeorm';
import { SettingEntity } from './setting.entity';

export const SETTINGS_STORE = Symbol('SETTINGS_STORE');

export interface SettingsStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export class PostgresSettingsStore implements SettingsStore {
  constructor(private readonly repo: Repository<SettingEntity>) {}

  async get(key: string) {
    return (await this.repo.findOne({ where: { key } }))?.value;
  }

  async set(key: string, value: unknown) {
    await this.repo.save({ key, value });
  }
}

/** Used when no DATABASE_URL is set; lost on restart. */
export class MemorySettingsStore implements SettingsStore {
  private readonly values = new Map<string, unknown>();

  async get(key: string) {
    return this.values.get(key);
  }

  async set(key: string, value: unknown) {
    this.values.set(key, value);
  }
}
