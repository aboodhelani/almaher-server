import { Module } from '@nestjs/common';
import { AdminController } from '../admin/admin.controller';
import { MatchesGateway } from './matches.gateway';
import { MatchesService } from './matches.service';
import { QuestionsModule } from '../questions/questions.module';
import { AuthModule } from '../auth/auth.module';
import { RulesModule } from '../rules/rules.module';

@Module({
  imports: [QuestionsModule, AuthModule, RulesModule],
  controllers: [AdminController],
  providers: [MatchesGateway, MatchesService],
})
export class MatchesModule {}
