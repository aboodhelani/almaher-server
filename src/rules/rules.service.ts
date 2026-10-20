import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { SETTINGS_STORE } from '../database/settings-store';
import type { SettingsStore } from '../database/settings-store';
import { DEFAULT_RULES, MatchRules, validateRules } from './rules.types';

const KEY = 'match_rules';

/** The competition rules: kept in memory, saved in the settings table. */
@Injectable()
export class RulesService implements OnModuleInit {
  private rules: MatchRules = DEFAULT_RULES;

  constructor(@Inject(SETTINGS_STORE) private readonly store: SettingsStore) {}

  async onModuleInit() {
    const saved = await this.store.get(KEY);
    // Saved rules over the defaults, so rules added later get their default.
    if (saved) this.rules = validateRules(saved);
  }

  get current(): MatchRules {
    return this.rules;
  }

  /** Changes some or all rules; new matches use them. */
  async update(input: unknown): Promise<MatchRules> {
    const next = validateRules(input, this.rules);
    await this.store.set(KEY, next);
    this.rules = next;
    return next;
  }

  async reset(): Promise<MatchRules> {
    await this.store.set(KEY, DEFAULT_RULES);
    this.rules = DEFAULT_RULES;
    return this.rules;
  }
}
