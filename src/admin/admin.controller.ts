import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MatchError } from '../matches/engine/match-engine';
import { mediaToken } from '../matches/media';
import { MatchesGateway } from '../matches/matches.gateway';
import { MatchesService } from '../matches/matches.service';
import { QuestionValidationError } from '../questions/question-validation';
import { QUESTION_TYPES, QuestionType } from '../questions/question.types';
import { QuestionsService } from '../questions/questions.service';
import { RulesService } from '../rules/rules.service';
import { RulesError } from '../rules/rules.types';
import { AdminKeyGuard } from './admin-key.guard';

/** Everything the dashboard reads and does. */
@Controller('admin')
@UseGuards(AdminKeyGuard)
export class AdminController {
  constructor(
    private readonly matches: MatchesService,
    private readonly gateway: MatchesGateway,
    private readonly questions: QuestionsService,
    private readonly rules: RulesService,
  ) {}

  // ── Competition rules ──

  @Get('rules')
  getRules() {
    return this.rules.current;
  }

  /** Changes some or all rules; matches created afterwards use them. */
  @Put('rules')
  async setRules(@Body() body: unknown) {
    try {
      return await this.rules.update(body);
    } catch (e) {
      if (e instanceof RulesError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Post('rules/reset')
  @HttpCode(200)
  resetRules() {
    return this.rules.reset();
  }

  /** Lets the dashboard check a key at login. */
  @Get('ping')
  ping() {
    return { ok: true };
  }

  // ── Matches ──

  @Get('matches/live')
  live() {
    const now = Date.now();
    return this.matches.live().map((m) => ({
      createdAt: m.createdAt,
      // The referee's view: everything, including the current answer.
      ...m.snapshotFor('referee', now),
    }));
  }

  /** The big-screen view of a match: the audience sees what players see. */
  @Get('matches/:code/display')
  display(@Param('code') code: string) {
    try {
      return this.matches.get(code).snapshotFor('spectator', Date.now());
    } catch (e) {
      if (e instanceof MatchError) throw new NotFoundException(e.code);
      throw e;
    }
  }

  /** The dashboard watches a remote match's audio/video (no publishing). */
  @Get('matches/:code/media')
  async media(@Param('code') code: string) {
    try {
      const match = this.matches.get(code);
      if (match.mode !== 'remote') throw new NotFoundException('not_remote');
      return await mediaToken(match.code, `viewer-${Date.now()}`, 'لوحة التحكم', false);
    } catch (e) {
      if (e instanceof MatchError) throw new NotFoundException(e.code);
      throw e;
    }
  }

  @Get('matches/history')
  history(@Query('limit') limit?: string) {
    return this.matches.history(Math.min(Number(limit) || 50, 200));
  }

  /** Creates a match from the dashboard, optionally under a chosen ID. */
  @Post('matches')
  create(@Body() body: { mode?: string; code?: string }) {
    try {
      const match = this.matches.create(body?.mode === 'remote' ? 'remote' : 'same_room', body?.code);
      // The dashboard referees its matches: prepare first, then publish.
      match.published = false;
      return { ok: true, code: match.code };
    } catch (e) {
      if (e instanceof MatchError) throw new BadRequestException(e.code);
      throw e;
    }
  }

  /** Ends a live match now: players see the result, history keeps it. */
  @Post('matches/:code/end')
  @HttpCode(200)
  async end(@Param('code') code: string) {
    try {
      const match = this.matches.get(code);
      match.end();
      await this.gateway.broadcast(match);
      return { ok: true, scores: match.scores, winner: match.winner };
    } catch (e) {
      if (e instanceof MatchError) {
        if (e.code === 'match_not_found') throw new NotFoundException(e.code);
        throw new BadRequestException(e.code);
      }
      throw e;
    }
  }

  // ── Question bank ──

  @Get('questions')
  list(@Query('type') type?: string, @Query('limit') limit?: string) {
    return this.questions.list(this.typeOrUndefined(type), Math.min(Number(limit) || 100, 500));
  }

  @Get('questions/counts')
  counts() {
    return this.questions.count();
  }

  /** Fresh generated questions of one type (not saved). */
  @Post('questions/generate')
  @HttpCode(200)
  generate(@Body() body: { type?: string; count?: number }) {
    const type = this.typeOrUndefined(body?.type);
    if (!type) throw new BadRequestException('invalid_type');
    return this.questions.generate(type, Math.min(Math.max(Number(body?.count) || 5, 1), 20));
  }

  /** Saves a question: one added by hand, or a generated one being kept. */
  @Post('questions')
  async add(@Body() body: unknown) {
    try {
      return await this.questions.add(body);
    } catch (e) {
      if (e instanceof QuestionValidationError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Delete('questions/:id')
  async remove(@Param('id') id: string) {
    if (!(await this.questions.remove(id))) throw new NotFoundException('question_not_found');
    return { ok: true };
  }

  private typeOrUndefined(type?: string): QuestionType | undefined {
    return QUESTION_TYPES.includes(type as QuestionType) ? (type as QuestionType) : undefined;
  }
}
