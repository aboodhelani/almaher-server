import { Module } from '@nestjs/common';
import { QuestionGeneratorService } from './question-generator.service';
import { QuestionsService } from './questions.service';

@Module({
  providers: [QuestionGeneratorService, QuestionsService],
  exports: [QuestionGeneratorService, QuestionsService],
})
export class QuestionsModule {}
