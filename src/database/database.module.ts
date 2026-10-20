import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MatchResultEntity } from './match-result.entity';
import { InitialSchema1760600000000 } from './migrations/1760600000000-initial-schema';
import { Settings1760700000000 } from './migrations/1760700000000-settings';
import { LongerMatchCode1760800000000 } from './migrations/1760800000000-longer-match-code';
import { SettingEntity } from './setting.entity';
import { MemorySettingsStore, PostgresSettingsStore, SETTINGS_STORE } from './settings-store';
import { QuestionEntity } from './question.entity';
import { UserEntity } from './user.entity';
import { MemoryUsersStore, PostgresUsersStore, USERS_STORE } from './users-store';
import {
  MemoryQuestionsStore,
  PostgresQuestionsStore,
  QUESTIONS_STORE,
} from './questions-store';
import {
  MemoryResultsStore,
  PostgresResultsStore,
  RESULTS_STORE,
} from './results-store';

/**
 * Postgres when DATABASE_URL is set (see docker-compose.yml), otherwise
 * in-memory stores so the game still runs in development.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(databaseUrl = process.env.DATABASE_URL): DynamicModule {
    const exports = [RESULTS_STORE, QUESTIONS_STORE, USERS_STORE, SETTINGS_STORE];
    if (!databaseUrl) {
      new Logger('Database').warn(
        'DATABASE_URL not set: results and questions are kept in memory only',
      );
      return {
        module: DatabaseModule,
        providers: [
          { provide: RESULTS_STORE, useClass: MemoryResultsStore },
          { provide: QUESTIONS_STORE, useClass: MemoryQuestionsStore },
          { provide: USERS_STORE, useClass: MemoryUsersStore },
          { provide: SETTINGS_STORE, useClass: MemorySettingsStore },
        ],
        exports,
      };
    }
    const entities = [MatchResultEntity, QuestionEntity, UserEntity, SettingEntity];
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities,
          // The schema comes from migrations (src/database/migrations), run
          // at start-up; never synchronized from the entities.
          synchronize: false,
          migrations: [InitialSchema1760600000000, Settings1760700000000, LongerMatchCode1760800000000],
          migrationsRun: true,
        }),
        TypeOrmModule.forFeature(entities),
      ],
      providers: [
        {
          provide: RESULTS_STORE,
          inject: [getRepositoryToken(MatchResultEntity)],
          useFactory: (repo: Repository<MatchResultEntity>) =>
            new PostgresResultsStore(repo),
        },
        {
          provide: QUESTIONS_STORE,
          inject: [getRepositoryToken(QuestionEntity)],
          useFactory: (repo: Repository<QuestionEntity>) =>
            new PostgresQuestionsStore(repo),
        },
        {
          provide: USERS_STORE,
          inject: [getRepositoryToken(UserEntity)],
          useFactory: (repo: Repository<UserEntity>) => new PostgresUsersStore(repo),
        },
        {
          provide: SETTINGS_STORE,
          inject: [getRepositoryToken(SettingEntity)],
          useFactory: (repo: Repository<SettingEntity>) => new PostgresSettingsStore(repo),
        },
      ],
      exports,
    };
  }
}
