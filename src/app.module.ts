import { RulesModule } from './rules/rules.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { MatchesModule } from './matches/matches.module';
import { QuranModule } from './quran/quran.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule.forRoot(),
    QuranModule,
    AuthModule,
    RulesModule,
    MatchesModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
