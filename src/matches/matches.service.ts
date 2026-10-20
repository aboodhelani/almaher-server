import { Inject, Injectable, Logger } from '@nestjs/common';
import { RESULTS_STORE } from '../database/results-store';
import type { ResultsStore } from '../database/results-store';
import { MatchEngine, MatchError } from './engine/match-engine';
import { MatchMode, Role } from './engine/types';
import { QuestionsService } from '../questions/questions.service';
import { GameQuestion } from './engine/types';
import { RulesService } from '../rules/rules.service';

/** Live matches, held in memory by code. */
@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);
  private readonly matches = new Map<string, MatchEngine>();
  private readonly saved = new Set<string>();
  /** `code:role` → timer that closes the match if they stay offline. */
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  /** code → timer that ends the question when its time runs out. */
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  /** How long a player or the referee may be offline before the match closes. */
  static offlineCloseMs = Number(process.env.OFFLINE_CLOSE_MS) || 5 * 60 * 1000;

  constructor(
    private readonly questions: QuestionsService,
    private readonly rules: RulesService,
    @Inject(RESULTS_STORE) private readonly results: ResultsStore,
  ) {}

  /**
   * Creates a match under [customCode] if given (so everyone can join that
   * exact match by its ID), otherwise under a random 6-digit code. A custom
   * code is free again once its match has finished.
   */
  create(mode: MatchMode, customCode?: string, perRound?: number): MatchEngine {
    let code: string;
    if (customCode !== undefined && String(customCode).trim() !== '') {
      code = normalizeCode(customCode);
      if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(code))
        throw new MatchError('invalid_code');
      if (this.isLive(code)) throw new MatchError('code_taken');
    } else {
      do {
        code = String(Math.floor(100000 + Math.random() * 900000));
      } while (this.isLive(code));
    }
    // The match keeps the rules as they are now.
    const match = new MatchEngine(code, mode, perRound, this.rules.current);
    this.matches.set(code, match);
    this.saved.delete(code);
    return match;
  }

  /**
   * No ID given: finds the longest-waiting lobby match with a free seat for
   * [role] (a player seat, or the referee), or creates a new match to wait in.
   */
  findOrCreate(role: 'player' | 'referee', mode: MatchMode): MatchEngine {
    const open = [...this.matches.values()].find((m) => {
      if (m.status !== 'lobby' || m.mode !== mode || !m.published) return false;
      if (role === 'referee') return !m.participants.referee?.connected;
      return (
        !m.participants.player1?.connected || !m.participants.player2?.connected
      );
    });
    if (open) return open;
    // A referee's new match starts as a draft they prepare and publish.
    const created = this.create(mode);
    if (role === 'referee') created.published = false;
    return created;
  }

  private isLive(code: string) {
    const m = this.matches.get(code);
    return !!m && m.status !== 'finished';
  }

  /** Every live (not yet finished) match, newest first. */
  live(): MatchEngine[] {
    return [...this.matches.values()]
      .filter((m) => m.status !== 'finished')
      .reverse();
  }

  history(limit: number) {
    return this.results.list(limit);
  }

  get(code: string): MatchEngine {
    const match = this.matches.get(normalizeCode(code));
    if (!match) throw new MatchError('match_not_found');
    return match;
  }

  /**
   * Starts a match: the questions of each round the referee chose, in the
   * show's order (4 of each round that is on, 20 in all, by default).
   */
  async start(match: MatchEngine) {
    const questions: GameQuestion[] = [];
    for (const { type, count } of match.plan) {
      // The referee's chosen questions first, the rest picked at random.
      const chosen = (match.setup[type] ?? []).slice(0, count);
      questions.push(...chosen);
      if (chosen.length >= count) continue;
      for (const q of await this.questions.forMatch(
        type,
        count - chosen.length,
      )) {
        questions.push(toGameQuestion(q));
      }
    }
    match.start(questions, Date.now());
  }

  /**
   * Swaps the current question for another of the same round (a different
   * prompt when one can be found).
   */
  /** Bank questions of [type] the referee can pick from. */
  async bank(type: GameQuestion['type']) {
    return (await this.questions.list(type, 200)).map(toGameQuestion);
  }

  /** Freshly generated questions of [type] to pick from. */
  suggest(type: GameQuestion['type'], count: number) {
    return this.questions.generate(type, count).map(toGameQuestion);
  }

  /** The referee's questions for one round, each checked like a bank question. */
  setQuestions(
    match: MatchEngine,
    type: GameQuestion['type'],
    bodies: unknown[],
  ) {
    if (!Array.isArray(bodies)) throw new MatchError('invalid_questions');
    const questions = bodies.map((b) => {
      try {
        return toGameQuestion(
          this.questions.prepare({ ...(b as object), type }),
        );
      } catch (e) {
        throw new MatchError(
          e instanceof Error ? e.message : 'invalid_question',
        );
      }
    });
    match.setQuestions(type, questions);
  }

  /**
   * The referee moves on. On the last question a tie-breaker from the last
   * round is fetched, in case the scores are level (see MatchEngine.next).
   */
  async next(match: MatchEngine) {
    let tiebreaker: GameQuestion | null = null;
    if (match.onLastQuestion) {
      const last = match.questions[match.questions.length - 1];
      const used = new Set(match.questions.map(questionKey));
      for (let tries = 0; tries < 6 && !tiebreaker; tries++) {
        const [q] = await this.questions.forMatch(last.type, 1, tries > 0);
        if (q && (!used.has(questionKey(q)) || tries === 5)) {
          tiebreaker = {
            type: q.type,
            prompt: q.prompt,
            answer: q.answer,
            refs: q.refs,
            timeLimitSeconds: q.timeLimitSeconds,
            meta: q.meta,
          };
        }
      }
    }
    match.next(Date.now(), tiebreaker);
  }

  async replaceQuestion(match: MatchEngine) {
    const current = match.current;
    if (!current) throw new MatchError('no_round');
    let next: GameQuestion | null = null;
    for (let tries = 0; tries < 6 && !next; tries++) {
      const [q] = await this.questions.forMatch(current.type, 1, tries > 0);
      if (q && (questionKey(q) !== questionKey(current) || tries === 5)) {
        next = {
          type: q.type,
          prompt: q.prompt,
          answer: q.answer,
          refs: q.refs,
          timeLimitSeconds: q.timeLimitSeconds,
          meta: q.meta,
        };
      }
    }
    if (!next) throw new MatchError('no_questions');
    match.replace(next, Date.now());
  }

  /** Saves a finished match once. */
  async saveIfFinished(match: MatchEngine) {
    if (match.status !== 'finished' || this.saved.has(match.code)) return;
    this.saved.add(match.code);
    try {
      await this.results.save({
        code: match.code,
        mode: match.mode,
        player1Name: match.participants.player1?.name ?? '',
        player2Name: match.participants.player2?.name ?? '',
        player1UserId: match.participants.player1?.userId ?? null,
        player2UserId: match.participants.player2?.userId ?? null,
        refereeName: match.participants.referee?.name ?? null,
        player1Score: match.scores.player1,
        player2Score: match.scores.player2,
        winner: match.winner ?? 'draw',
      });
    } catch (e) {
      this.saved.delete(match.code);
      this.logger.error(`Could not save match ${match.code}: ${String(e)}`);
    }
  }

  /**
   * [role] went offline: if they are still offline after
   * [MatchesService.offlineCloseMs] the match ends with the current scores and
   * [onClosed] runs (to tell the others and save the result).
   */
  scheduleOfflineClose(match: MatchEngine, role: Role, onClosed: () => void) {
    this.cancelOfflineClose(match, role);
    if (match.status === 'finished') return;
    const key = `${match.code}:${role}`;
    const timer = setTimeout(() => {
      this.offlineTimers.delete(key);
      const p = match.participants[role];
      if (match.status === 'finished' || !p || p.connected) return;
      match.end();
      this.logger.log(`Match ${match.code} closed: ${role} offline too long`);
      onClosed();
    }, MatchesService.offlineCloseMs);
    timer.unref?.();
    this.offlineTimers.set(key, timer);
  }

  /**
   * Wakes up when the state changes by itself (see [MatchEngine.wakeAt]):
   * ends the question if its time ran out, then runs [onChanged] to tell
   * everyone. Called after every broadcast; replaces the previous timer.
   */
  armExpiry(match: MatchEngine, onChanged: () => void) {
    clearTimeout(this.expiryTimers.get(match.code));
    this.expiryTimers.delete(match.code);
    const at = match.wakeAt(Date.now());
    if (at === null) return;
    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(match.code);
        match.expire(Date.now());
        onChanged();
      },
      Math.max(0, at - Date.now()) + 20,
    );
    timer.unref?.();
    this.expiryTimers.set(match.code, timer);
  }

  /** [role] is back: the match stays open. */
  cancelOfflineClose(match: MatchEngine, role: Role) {
    const key = `${match.code}:${role}`;
    clearTimeout(this.offlineTimers.get(key));
    this.offlineTimers.delete(key);
  }
}

/**
 * Match IDs are compared trimmed, case-insensitively, and with Arabic-Indic
 * digits as Western ones (an Arabic keyboard types ٢٠٢٦ for 2026).
 */
export function normalizeCode(code: string): string {
  return String(code)
    .trim()
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The parts of a bank or generated question a match plays. */
function toGameQuestion(q: {
  type: GameQuestion['type'];
  prompt: string;
  answer: string;
  refs: GameQuestion['refs'];
  timeLimitSeconds: number;
  meta: Record<string, unknown>;
}): GameQuestion {
  return {
    type: q.type,
    prompt: q.prompt,
    answer: q.answer,
    refs: q.refs,
    timeLimitSeconds: q.timeLimitSeconds,
    meta: q.meta,
  };
}

/** Tells questions apart (يمين يسار questions share a prompt). */
function questionKey(q: {
  prompt: string;
  refs: { surah: number; ayah: number }[];
}) {
  return `${q.prompt}|${q.refs.map((r) => `${r.surah}:${r.ayah}`).join(',')}`;
}
