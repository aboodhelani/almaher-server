import {
  GameQuestion,
  MatchMode,
  MatchStatus,
  Participant,
  PLAYERS,
  PlayerRole,
  Role,
} from './types';
import { DEFAULT_RULES, enabledRounds, MatchRules } from '../../rules/rules.types';
import { QUESTION_TYPES, QuestionType } from '../../questions/question.types';

export class MatchError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type Verdict = 'correct' | 'wrong';

/** Live state of the question being played. */
export interface QuestionState {
  phase: 'answering' | 'revealed';
  /**
   * Epoch ms after which numbers/bids/buzzes are no longer accepted; during an
   * المزاد recital, when the reciter's time runs out.
   */
  deadline: number;
  startedAt: number;
  /** Length of the current countdown (the question, or the recital). */
  limitSeconds: number;
  /** رقم الآيات: secret numbers. المزاد: each player's latest (open) bid. */
  answers: Record<PlayerRole, number | null>;
  answeredAt: Record<PlayerRole, number | null>;
  /** ماذا تعرف: players who used their one pass on this question. */
  passed: PlayerRole[];
  /**
   * ماذا تعرف: whose turn it is, strikes, and the answers ticked off.
   * المتشابهات: strikes too (3 and a player may no longer answer).
   */
  turn: PlayerRole;
  strikes: Record<PlayerRole, number>;
  said: string[];
  /** المزاد: who holds the highest bid, and (bidding closed) who recites. */
  highBidder: PlayerRole | null;
  reciter: PlayerRole | null;
  /**
   * الجرس: who answered, in order (the first by buzzing, the second handed
   * the chance after a wrong answer), when, and who was wrong.
   * المتشابهات: players who used their strikes.
   */
  buzzes: PlayerRole[];
  buzzedAt: number[];
  lockedOut: PlayerRole[];
  /** Who got the point, and how many points each, once revealed. */
  awarded: PlayerRole[];
  points: number;
  /** Times the referee swapped this question for an alternative. */
  replaced: number;
  /** The player who gave this question up (the other one got its points). */
  forfeited: PlayerRole | null;
  /** آية بآية: next ayahs recited so far (the turn passes after each). */
  step: number;
  /** يمين يسار: the runs. */
  rl: RightLeftState | null;
}

const other = (p: PlayerRole): PlayerRole => (p === 'player1' ? 'player2' : 'player1');

/**
 * المزاد: what a completed recital of [bid] answers is worth — 1 point under
 * 20, then a point per full ten (20–29: 2, 30–39: 3, …).
 */
export const auctionPoints = (bid: number) => (bid < 20 ? 1 : Math.floor(bid / 10));

export type Side = 'right' | 'left';

/** يمين يسار: one opening of a run, as the question's meta lists it. */
interface RightLeftItem {
  text: string;
  page: number;
  side: Side;
  surah: number;
  ayah: number;
  surahName: string;
}

/**
 * يمين يسار: each player's run of openings in turn. A run waits ('ready')
 * until the referee starts it, then shows one opening at a time.
 */
interface RightLeftState {
  player: PlayerRole;
  stage: 'ready' | 'running';
  index: number;
  /** Each player's answers (null: time ran out), in order. */
  answers: Record<PlayerRole, (Side | null)[]>;
  /** Players whose run is over (the first is the first run). */
  done: PlayerRole[];
}

/** آية بآية: one next ayah of the question (see its `meta.chain`). */
interface ChainAyah {
  surah: number;
  ayah: number;
  surahName: string;
  text: string;
  /** The words that tell this ayah apart: what the player must say. */
  opening: string;
}

/**
 * One match between two players, run by a referee: by default 4 questions of
 * each round that is on; the referee may pick the rounds and their counts. The server holds the only copy; clients get role-filtered snapshots
 * from [snapshotFor].
 *
 * Time is passed in (`now`) so the engine is deterministic and testable.
 */
export class MatchEngine {
  status: MatchStatus = 'lobby';
  participants: Partial<Record<Role, Participant>> = {};
  scores: Record<PlayerRole, number> = { player1: 0, player2: 0 };
  questions: GameQuestion[] = [];
  index = 0;
  /** Questions in the match proper; any after them are tie-breakers. */
  regularCount = 0;
  /**
   * False while the referee prepares the match: players cannot join it
   * until it is published.
   */
  published = true;
  /** Questions the referee chose per round (the rest are picked at start). */
  setup: Partial<Record<GameQuestion['type'], GameQuestion[]>> = {};
  q: QuestionState | null = null;
  /** The player who quit the match: the other one wins it, whatever the scores. */
  forfeitedBy: PlayerRole | null = null;
  readonly createdAt = new Date();

  /** Questions in each round by default. */
  readonly perRound: number;

  /**
   * Questions in each round this match plays, as the referee chose them
   * while preparing (rounds with 0, or missing, are left out).
   */
  roundCounts: Partial<Record<QuestionType, number>> = {};

  /** Random numbers (tests replace it to fix who opens the bidding). */
  random: () => number = Math.random;

  /** المزاد: who opens the first question's bidding (drawn when needed). */
  private firstBidder: PlayerRole | null = null;

  constructor(
    readonly code: string,
    readonly mode: MatchMode,
    perRound?: number,
    /** The rules as they were when the match was created. */
    readonly rules: MatchRules = DEFAULT_RULES,
  ) {
    this.perRound = perRound ?? rules.questionsPerRound;
    for (const type of enabledRounds(rules)) this.roundCounts[type] = this.perRound;
  }

  /** The rounds this match plays and their question counts, in the show's order. */
  get plan(): { type: QuestionType; count: number }[] {
    return QUESTION_TYPES.filter((t) => (this.roundCounts[t] ?? 0) > 0).map((type) => ({
      type,
      count: this.roundCounts[type]!,
    }));
  }

  // ── Seats ──

  join(role: Role, name: string, userId?: string) {
    if (role !== 'referee' && !this.published) throw new MatchError('not_published');
    const current = this.participants[role];
    const same = !!userId && current?.userId === userId;
    if (current?.connected && !same) throw new MatchError('role_taken');
    if (userId && PLAYERS.some((p) => p !== role && this.participants[p]?.userId === userId)) {
      throw new MatchError('already_player');
    }
    this.participants[role] = { name, connected: true, ...(userId ? { userId } : {}) };
  }

  /**
   * Seats a player without them choosing first or second: their old seat if
   * they are reconnecting (same account, or same name without one), else the
   * first empty seat, else a seat whose player has left.
   */
  joinAsPlayer(name: string, userId?: string): PlayerRole {
    if (!this.published) throw new MatchError('not_published');
    if (userId && this.participants.referee?.userId === userId) {
      throw new MatchError('already_referee');
    }
    const seat =
      PLAYERS.find((p) => {
        const s = this.participants[p];
        if (!s) return false;
        return userId ? s.userId === userId : !s.connected && s.name === name;
      }) ??
      PLAYERS.find((p) => !this.participants[p]) ??
      PLAYERS.find((p) => !this.participants[p]!.connected);
    if (!seat) throw new MatchError('match_full');
    this.participants[seat] = { name, connected: true, ...(userId ? { userId } : {}) };
    return seat;
  }

  setConnected(role: Role, connected: boolean, now = Date.now()) {
    const p = this.participants[role];
    if (!p) return;
    p.connected = connected;
    if (connected) delete p.offlineSince;
    else p.offlineSince = now;
  }

  // ── Preparing (referee, before publishing) ──

  /**
   * Which rounds this match plays and how many questions each (any round the
   * rules leave on, 0 to skip it), within the rules' limits. At least one
   * question in all; the referee's chosen questions beyond a round's new
   * count are dropped.
   */
  setRoundCounts(input: unknown) {
    if (this.status !== 'lobby') throw new MatchError('already_started');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new MatchError('invalid_rounds');
    }
    const allowed = enabledRounds(this.rules);
    const counts: Partial<Record<QuestionType, number>> = {};
    for (const [type, value] of Object.entries(input as Record<string, unknown>)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > this.rules.maxPerRound) throw new MatchError('invalid_count');
      if (n === 0) continue;
      if (!allowed.includes(type as QuestionType)) throw new MatchError('round_off');
      counts[type as QuestionType] = n;
    }
    const total = Object.values(counts).reduce((a, n) => a + n, 0);
    if (total === 0) throw new MatchError('no_rounds');
    if (total > this.rules.maxQuestions) throw new MatchError('too_many_questions');
    this.roundCounts = counts;
    for (const type of Object.keys(this.setup) as QuestionType[]) {
      const count = counts[type] ?? 0;
      if (count === 0) delete this.setup[type];
      else this.setup[type] = this.setup[type]!.slice(0, count);
    }
  }

  /** The referee's questions for one round (at most its count). */
  setQuestions(type: GameQuestion['type'], questions: GameQuestion[]) {
    if (this.status !== 'lobby') throw new MatchError('already_started');
    if (questions.some((q) => q.type !== type)) throw new MatchError('wrong_round');
    const count = this.roundCounts[type] ?? 0;
    if (count === 0) throw new MatchError('round_off');
    if (questions.length > count) throw new MatchError('too_many_questions');
    this.setup[type] = questions;
  }

  /** Opens the match to players. */
  publish() {
    if (this.status !== 'lobby') throw new MatchError('already_started');
    this.published = true;
  }

  // ── Flow ──

  /** Referee starts the match with its questions, in round order. */
  start(questions: GameQuestion[], now: number) {
    if (!this.published) throw new MatchError('not_published');
    if (!this.participants.player1 || !this.participants.player2) {
      throw new MatchError('players_missing');
    }
    if (questions.length === 0) throw new MatchError('no_questions');
    this.questions = questions;
    this.regularCount = questions.length;
    this.index = 0;
    this.status = 'playing';
    this.q = this.freshState(now);
  }

  /** True on the last question: moving on may need a [tiebreaker]. */
  get onLastQuestion() {
    return this.status === 'playing' && this.index + 1 >= this.questions.length;
  }

  /**
   * Next question (the first player alternates), or finishes after the last.
   * The referee may move on at any time; an undecided question ends with no
   * point. A match cannot end level: while the scores are equal after the
   * last question, [tiebreaker] (one more question of the last round) is
   * played; without one it ends as a draw.
   */
  next(now: number, tiebreaker?: GameQuestion | null) {
    const q = this.requireQuestion();
    if (q.phase !== 'revealed') this.decide([]);
    if (this.index + 1 >= this.questions.length) {
      if (this.scores.player1 !== this.scores.player2 || !tiebreaker) {
        this.status = 'finished';
        return;
      }
      this.questions.push(tiebreaker);
    }
    this.index += 1;
    this.q = this.freshState(now);
  }

  /**
   * The referee swaps the current question for [question] (same round) at any
   * time and it starts afresh; players are told it is an alternative
   * question. Points the replaced question gave are taken back.
   */
  replace(question: GameQuestion, now: number) {
    const q = this.requireQuestion();
    if (question.type !== this.current!.type) throw new MatchError('wrong_round');
    for (const p of q.awarded) this.scores[p] = Math.max(0, this.scores[p] - q.points);
    this.questions[this.index] = question;
    const replaced = q.replaced + 1;
    this.q = { ...this.freshState(now), replaced };
  }

  /** Ends the match now (the referee or the dashboard), with the current scores. */
  end() {
    if (this.status === 'finished') throw new MatchError('already_finished');
    this.status = 'finished';
  }

  /**
   * [player] gives up the current question: it ends and the other player gets
   * the round's usual points.
   */
  forfeitQuestion(player: PlayerRole) {
    const q = this.requireQuestion();
    if (q.phase !== 'answering') throw new MatchError('not_answering');
    this.decide([other(player)]);
    q.forfeited = player;
  }

  /** [player] quits the match: it ends now and the other player wins. */
  forfeit(player: PlayerRole) {
    if (this.status === 'finished') throw new MatchError('already_finished');
    if (this.status !== 'playing') throw new MatchError('no_round');
    this.forfeitedBy = player;
    this.status = 'finished';
  }

  get current(): GameQuestion | null {
    return this.status === 'playing' ? this.questions[this.index] : null;
  }

  // ── Player actions ──

  /**
   * رقم الآيات: the guessed ayah count (once, secret).
   * المزاد: an open bid, in turn (the opener first). It must beat the highest
   * bid, the turn then passes to the other player, and every bid restarts
   * the bidding clock.
   */
  answer(player: PlayerRole, value: number, now: number) {
    const q = this.requireQuestion();
    const type = this.current!.type;
    if (type !== 'ayah_number' && type !== 'auction') throw new MatchError('wrong_round');
    if (q.phase !== 'answering' || (type === 'auction' && q.reciter)) {
      throw new MatchError('not_answering');
    }
    if (now > q.deadline) throw new MatchError('time_up');
    if (type === 'ayah_number') {
      if (q.answers[player] !== null) throw new MatchError('already_answered');
      if (!Number.isInteger(value) || value < 1 || value > 999) {
        throw new MatchError('invalid_answer');
      }
    } else {
      if (q.highBidder === player) throw new MatchError('already_highest');
      if (q.turn !== player) throw new MatchError('not_your_turn');
      const high = q.highBidder ? q.answers[q.highBidder]! : 0;
      const max = Number(this.current!.meta.total ?? 999);
      if (!Number.isInteger(value) || value <= high || value > max) {
        throw new MatchError('invalid_answer');
      }
      q.highBidder = player;
      q.turn = other(player);
      q.deadline = now + this.rules.rounds.auction.bidSeconds * 1000;
      if (value === max) {
        // Nobody can outbid the maximum: the bidder recites at once.
        q.answers[player] = value;
        q.answeredAt[player] = now;
        this.closeBidding(now);
        return;
      }
    }
    q.answers[player] = value;
    q.answeredAt[player] = now;
  }

  /**
   * ماذا تعرف: [player], whose turn it is, has no answer and hands the turn
   * over without a strike (once per question).
   * المزاد: [player] lets the other player, who holds the highest bid, go
   * ahead and recite.
   */
  pass(player: PlayerRole, now: number) {
    const q = this.requireQuestion();
    if (this.current!.type === 'what_do_you_know') {
      if (q.phase !== 'answering') throw new MatchError('not_answering');
      if (q.turn !== player) throw new MatchError('not_your_turn');
      if (q.passed.includes(player)) throw new MatchError('already_passed');
      q.passed.push(player);
      q.turn = other(player);
      return;
    }
    if (this.current!.type !== 'auction') throw new MatchError('wrong_round');
    if (q.phase !== 'answering' || q.reciter) throw new MatchError('not_answering');
    if (q.highBidder !== other(player)) throw new MatchError('no_bid_to_pass');
    this.closeBidding(now);
  }

  /** يمين يسار: the referee starts the waiting player's run. */
  startRun(now: number) {
    const q = this.requireQuestion();
    const rl = q.rl;
    if (!rl || q.phase !== 'answering') throw new MatchError('wrong_round');
    if (rl.stage !== 'ready') throw new MatchError('run_started');
    rl.stage = 'running';
    rl.index = 0;
    this.nextItem(now);
  }

  /** يمين يسار: the running player says which side the opening's page is on. */
  answerSide(player: PlayerRole, side: Side, now: number) {
    const q = this.requireQuestion();
    const rl = q.rl;
    if (!rl || q.phase !== 'answering' || rl.stage !== 'running') throw new MatchError('not_answering');
    if (rl.player !== player) throw new MatchError('not_your_turn');
    if (side !== 'right' && side !== 'left') throw new MatchError('invalid_answer');
    if (now > q.deadline) throw new MatchError('time_up');
    rl.answers[player].push(side);
    this.advanceRun(now);
  }

  /** الجرس: press the buzzer to answer. */
  buzz(player: PlayerRole, now: number) {
    const q = this.requireQuestion();
    const type = this.current!.type;
    if (type !== 'buzzer') throw new MatchError('wrong_round');
    if (q.phase !== 'answering') throw new MatchError('not_answering');
    if (now > q.deadline) throw new MatchError('time_up');
    if (q.lockedOut.includes(player)) throw new MatchError('locked_out');
    if (this.activeBuzzer(q)) throw new MatchError('someone_answering');
    q.buzzes.push(player);
    q.buzzedAt.push(now);
  }

  // ── Referee actions ──

  /**
   * رقم الآيات: reveals and scores: the exact count (the faster of two exact
   * answers), else the closest; both when equally close with different
   * numbers, nobody when both wrote the same wrong number.
   * المزاد: closes the bidding; the highest bidder recites, with
   * the recital time to do it.
   */
  reveal(now: number) {
    const q = this.requireQuestion();
    const question = this.current!;
    if (q.phase !== 'answering') throw new MatchError('not_answering');
    const answered = PLAYERS.filter((p) => q.answers[p] !== null);

    if (question.type === 'ayah_number') {
      const correct = Number(question.answer);
      let awarded = answered.filter((p) => q.answers[p] === correct);
      if (awarded.length > 1) {
        // Both exact: the one who answered first takes it.
        awarded = [awarded.reduce((a, b) => (q.answeredAt[b]! < q.answeredAt[a]! ? b : a))];
      }
      if (awarded.length === 0 && answered.length > 0) {
        const distance = (p: PlayerRole) => Math.abs(q.answers[p]! - correct);
        const best = Math.min(...answered.map(distance));
        awarded = answered.filter((p) => distance(p) === best);
        if (awarded.length > 1 && q.answers.player1 === q.answers.player2) awarded = [];
      }
      this.decide(awarded);
      return;
    }
    if (question.type === 'auction') {
      if (q.reciter) throw new MatchError('bidding_closed');
      return this.closeBidding(now);
    }
    throw new MatchError('wrong_round');
  }

  /**
   * The referee's ✓ / ✗ for the answer being given:
   * - ماذا تعرف: ✓ ticks [ref] off and passes the turn; ✗ is a strike for the
   *   player whose turn it is, and the third gives the other player the point.
   * - المزاد: ✓ the reciter delivered in time ([auctionPoints] of the bid);
   *   ✗ the opponent's usual point.
   *   Running out of time is the same as ✗ (see [expire]).
   * - المتشابهات: either player answers aloud, and [player] says who. ✓ is
   *   worth the points tier for the time; ✗ is a strike, and once out of
   *   strikes that player may not answer. Both out: no point.
   * - السرد: the same, for the ayah's last word, with one points value.
   * - الجرس: ✓ the buzzer's point; ✗ shows everyone the question and hands
   *   the other player the chance; both wrong ends it with no point.
   * - آية بآية: ✓ the player said the next ayah's opening, and the turn
   *   passes with a fresh clock; ✗ the other player's point. Reaching the
   *   end of the listed ayahs (the surah's end) gives nobody the point.
   */
  judge(verdict: Verdict, ref: string | undefined, now: number, player?: PlayerRole) {
    const q = this.requireQuestion();
    if (q.phase !== 'answering') throw new MatchError('not_answering');
    switch (this.current!.type) {
      case 'what_do_you_know': {
        if (verdict === 'correct') {
          if (ref && !q.said.includes(ref)) q.said.push(ref);
        } else {
          q.strikes[q.turn] += 1;
          const rules = this.rules.rounds.what_do_you_know;
          if (q.strikes[q.turn] >= rules.strikes) {
            // A winner who made no mistake earns more.
            const winner = other(q.turn);
            return this.decide([winner], q.strikes[winner] === 0 ? rules.cleanPoints : rules.points);
          }
        }
        q.turn = other(q.turn);
        return;
      }
      case 'auction':
        if (!q.reciter) throw new MatchError('bidding_open');
        // A recital is worth more the bigger the bid; failing gives the
        // opponent the round's usual points.
        return verdict === 'correct'
          ? this.decide([q.reciter], auctionPoints(q.answers[q.reciter]!))
          : this.decide([other(q.reciter)]);
      case 'similar':
      case 'sard': {
        if (!player) throw new MatchError('invalid_player');
        if (q.lockedOut.includes(player)) throw new MatchError('locked_out');
        if (verdict === 'correct') return this.decide([player], this.pointsFor(now));
        q.strikes[player] += 1;
        const type = this.current!.type as 'similar' | 'sard';
        if (q.strikes[player] >= this.rules.rounds[type].strikes) q.lockedOut.push(player);
        if (PLAYERS.every((p) => q.lockedOut.includes(p))) return this.decide([]);
        return;
      }
      case 'ayah_by_ayah': {
        if (verdict === 'wrong') return this.decide([other(q.turn)]);
        q.step += 1;
        if (q.step >= this.chain().length) return this.decide([]);
        q.turn = other(q.turn);
        q.deadline = now + q.limitSeconds * 1000;
        return;
      }
      case 'buzzer': {
        const buzzer = this.activeBuzzer(q);
        if (!buzzer) throw new MatchError('nobody_buzzed');
        if (verdict === 'correct') {
          return this.decide([buzzer], this.pointsFor(q.buzzedAt[q.buzzedAt.length - 1]));
        }
        q.lockedOut.push(buzzer);
        const next = other(buzzer);
        if (q.lockedOut.includes(next)) return this.decide([]);
        // The other player answers next without having to buzz.
        if (q.buzzes[q.buzzes.length - 1] !== next) {
          q.buzzes.push(next);
          q.buzzedAt.push(now);
        }
        return;
      }
      default:
        throw new MatchError('wrong_round');
    }
  }

  /**
   * Ends the current question by hand: a point to [player] (المتشابهات: what
   * the question is worth at [now]), or none.
   */
  award(player: PlayerRole | null, now: number) {
    const q = this.requireQuestion();
    if (q.phase !== 'answering') throw new MatchError('not_answering');
    this.decide(player ? [player] : [], this.pointsFor(now));
  }

  /**
   * Time ran out (the server calls this at [QuestionState.deadline]); true if
   * it ended the question:
   * - المزاد bidding: the highest bidder recites (no bids: no point);
   *   recital not delivered → the opponent's point.
   * - المتشابهات / السرد: no point. الجرس with nobody answering → no point.
   * - آية بآية: the player whose turn it is was too slow → the other's point.
   */
  expire(now: number): boolean {
    const q = this.q;
    if (!q || this.status !== 'playing' || q.phase !== 'answering' || now < q.deadline) {
      return false;
    }
    const type = this.current!.type;
    if (type === 'right_left') {
      if (!q.rl || q.rl.stage !== 'running') return false;
      q.rl.answers[q.rl.player].push(null); // too slow: not counted
      this.advanceRun(now);
      return true;
    }
    if (type === 'ayah_by_ayah') {
      this.decide([other(q.turn)]);
      return true;
    }
    if (type === 'auction') {
      if (q.reciter) this.decide([other(q.reciter)]);
      else if (q.highBidder) this.closeBidding(now);
      else this.decide([]);
      return true;
    }
    if (type === 'similar' || type === 'sard' || (type === 'buzzer' && !this.activeBuzzer(q))) {
      this.decide([]);
      return true;
    }
    return false;
  }

  /**
   * When the state next changes by itself: [expire] is due, or an المتشابهات
   * question drops to its next points tier. Null if nothing is pending.
   */
  wakeAt(now: number): number | null {
    const q = this.q;
    if (!q || this.status !== 'playing' || q.phase !== 'answering') return null;
    const type = this.current!.type;
    if (type === 'auction') return q.deadline;
    if (type === 'sard' || type === 'ayah_by_ayah') return q.deadline;
    if (type === 'right_left') return q.rl?.stage === 'running' ? q.deadline : null;
    if (type !== 'similar' && type !== 'buzzer') return null;
    if (type === 'buzzer' && this.activeBuzzer(q)) return null;
    if (type === 'similar') {
      const tier = this.similarTiers()
        .map((t) => q.startedAt + t.withinSeconds * 1000)
        .find((at) => at > now);
      if (tier !== undefined && tier < q.deadline) return tier;
    }
    return q.deadline;
  }

  /** Referee correction, e.g. after reviewing an answer. */
  adjustScore(player: PlayerRole, delta: number) {
    this.scores[player] = Math.max(0, this.scores[player] + delta);
  }

  get winner(): PlayerRole | 'draw' | null {
    if (this.status !== 'finished') return null;
    if (this.forfeitedBy) return other(this.forfeitedBy);
    const { player1, player2 } = this.scores;
    if (player1 === player2) return 'draw';
    return player1 > player2 ? 'player1' : 'player2';
  }

  // ── What each role sees ──

  /**
   * Players see the question but not the answer key; numbers and bids stay
   * secret until revealed; how fast each answered is for the referee only.
   */
  /**
   * [role] may also be 'spectator' (the big screen): sees what players see,
   * without being either of them.
   */
  snapshotFor(role: Role | 'spectator', now: number) {
    const q = this.q;
    const question = this.current;
    let round: Record<string, unknown> | null = null;
    if (q && question) {
      const isReferee = role === 'referee';
      const revealed = q.phase === 'revealed';
      const showKey = revealed || isReferee;
      // المزاد bids are open: everyone sees them.
      const openBids = question.type === 'auction';
      const tiebreak = this.index >= this.regularCount;
      // The rounds as played: runs of the same type (a tie-breaker counts as
      // the last question of the last round).
      const segments = this.segments();
      const at = Math.min(this.index, this.regularCount - 1);
      let roundIndex = 0;
      let start = 0;
      while (roundIndex < segments.length - 1 && at >= start + segments[roundIndex].count) {
        start += segments[roundIndex].count;
        roundIndex += 1;
      }
      round = {
        type: question.type,
        index: at,
        total: this.regularCount,
        roundIndex,
        roundTotal: segments.length,
        indexInRound: at - start,
        roundSize: segments[roundIndex]?.count ?? 1,
        segments,
        // A question added because the scores were level at the end.
        tiebreak,
        phase: q.phase,
        secondsLeft: q.limitSeconds ? Math.max(0, Math.ceil((q.deadline - now) / 1000)) : 0,
        timeLimitSeconds: q.limitSeconds,
        ...(question.type === 'similar' && q.phase === 'answering'
          ? { worth: this.pointsFor(now) }
          : {}),
        replaced: q.replaced > 0,
        forfeited: q.forfeited,
        question: {
          // الجرس: players hear the question from the referee and must not
          // read ahead of it; everyone sees it after a wrong answer.
          ...(question.type === 'buzzer' && !isReferee && !revealed && q.lockedOut.length === 0
            ? { prompt: null, promptHidden: true }
            : // يمين يسار: the opening on screen during a run.
              { prompt: this.currentItem()?.text ?? question.prompt }),
          ...(question.type === 'auction' ? { total: question.meta.total } : {}),
          ...(showKey
            ? {
                answer: question.answer,
                refs: question.refs.map((r) => ({
                  ...r,
                  said: q.said.includes(`${r.surah}:${r.ayah}`),
                })),
                meta: question.meta,
              }
            : {}),
        },
        answers: Object.fromEntries(
          PLAYERS.map((p) => [
            p,
            {
              submitted: q.answers[p] !== null,
              value:
                revealed || isReferee || p === role || openBids ? q.answers[p] : null,
              ...(isReferee && q.answeredAt[p] !== null
                ? { secondsTaken: Math.round((q.answeredAt[p]! - q.startedAt) / 100) / 10 }
                : {}),
            },
          ]),
        ),
        ...(isReferee ? { firstAnswered: this.firstAnswered(q) } : {}),
        turn: q.turn,
        strikes: q.strikes,
        passed: q.passed,
        maxStrikes:
          question.type === 'similar' || question.type === 'sard'
            ? this.rules.rounds[question.type].strikes
            : this.rules.rounds.what_do_you_know.strikes,
        lockedOut: q.lockedOut,
        saidCount: q.said.length,
        ...(q.rl ? { rightLeft: this.rightLeftSnapshot(isReferee || revealed) } : {}),
        ...(question.type === 'ayah_by_ayah' ? { chain: this.chainSnapshot(showKey) } : {}),
        highBidder: q.highBidder,
        reciter: q.reciter,
        buzzes: q.buzzes,
        activeBuzzer: this.activeBuzzer(q),
        awarded: q.awarded,
        points: q.points,
      };
    }
    return {
      code: this.code,
      mode: this.mode,
      status: this.status,
      published: this.published,
      perRound: this.perRound,
      // The rounds this match plays (with their question counts), the rounds
      // the referee may choose from, and its rules (timers, points, strikes).
      rounds: this.plan.map((r) => r.type),
      roundCounts: this.roundCounts,
      availableRounds: enabledRounds(this.rules),
      maxPerRound: this.rules.maxPerRound,
      maxQuestions: this.rules.maxQuestions,
      rules: this.rules,
      // The referee's chosen questions, while preparing (referee only).
      ...(role === 'referee' && this.status === 'lobby' ? { setup: this.setup } : {}),
      you: role,
      participants: this.participants,
      scores: this.scores,
      round,
      winner: this.winner,
      forfeitedBy: this.forfeitedBy,
    };
  }

  // ── Internals ──

  /** The match proper as rounds: consecutive questions of the same type. */
  private segments(): { type: QuestionType; count: number }[] {
    const out: { type: QuestionType; count: number }[] = [];
    for (const q of this.questions.slice(0, this.regularCount)) {
      const last = out[out.length - 1];
      if (last && last.type === q.type) last.count += 1;
      else out.push({ type: q.type, count: 1 });
    }
    return out;
  }

  private freshState(now: number): QuestionState {
    const question = this.questions[this.index];
    // Each round's clock is part of its rules, not of the question. ماذا
    // تعرف runs without one (0 = no timer); the referee moves on.
    const limit = this.roundSeconds(question.type);
    return {
      phase: 'answering',
      startedAt: now,
      limitSeconds: limit,
      deadline: limit ? now + limit * 1000 : Number.MAX_SAFE_INTEGER,
      answers: { player1: null, player2: null },
      answeredAt: { player1: null, player2: null },
      // ماذا تعرف: the first turn alternates between questions. المزاد: the
      // first question's opener is drawn at random, then they alternate.
      turn: question.type === 'auction' ? this.auctionOpener() : this.index % 2 === 0 ? 'player1' : 'player2',
      strikes: { player1: 0, player2: 0 },
      passed: [],
      said: [],
      highBidder: null,
      reciter: null,
      buzzes: [],
      buzzedAt: [],
      lockedOut: [],
      awarded: [],
      points: 0,
      replaced: 0,
      forfeited: null,
      step: 0,
      rl:
        question.type === 'right_left'
          ? {
              player: this.index % 2 === 0 ? 'player1' : 'player2',
              stage: 'ready',
              index: 0,
              answers: { player1: [], player2: [] },
              done: [],
            }
          : null,
    };
  }

  /** يمين يسار: the openings, half per run. */
  private rightLeftItems(): RightLeftItem[] {
    return (this.current!.meta.items as RightLeftItem[] | undefined) ?? [];
  }

  private get perRun() {
    return Math.floor(this.rightLeftItems().length / 2);
  }

  /** يمين يسار: the opening on screen now (its run's offset + index). */
  private currentItem(): RightLeftItem | null {
    const rl = this.q?.rl;
    if (!rl || rl.stage !== 'running') return null;
    return this.rightLeftItems()[rl.done.length * this.perRun + rl.index] ?? null;
  }

  private nextItem(now: number) {
    const q = this.q!;
    const seconds = this.rules.rounds.right_left.itemSeconds;
    q.limitSeconds = seconds;
    q.deadline = now + seconds * 1000;
  }

  /**
   * يمين يسار: the next opening, or the end of the run: then the other
   * player's run waits for the referee, or after both runs the player with
   * more right answers gets the point (a tie: nobody).
   */
  private advanceRun(now: number) {
    const q = this.q!;
    const rl = q.rl!;
    rl.index += 1;
    if (rl.index < this.perRun) return this.nextItem(now);
    rl.done.push(rl.player);
    rl.stage = 'ready';
    rl.index = 0;
    q.limitSeconds = 0;
    q.deadline = Number.MAX_SAFE_INTEGER;
    if (rl.done.length < 2) {
      rl.player = other(rl.player);
      return;
    }
    const right = (p: PlayerRole) => this.rightLeftCorrect(p).filter(Boolean).length;
    const [a, b] = [right('player1'), right('player2')];
    this.decide(a === b ? [] : [a > b ? 'player1' : 'player2']);
  }

  /** يمين يسار: whether each of [player]'s answers was right. */
  private rightLeftCorrect(player: PlayerRole): boolean[] {
    const rl = this.q!.rl!;
    // A finished run's place, or the next place for the run in progress.
    const run = rl.done.includes(player) ? rl.done.indexOf(player) : rl.done.length;
    const items = this.rightLeftItems();
    return rl.answers[player].map((side, i) => side === items[run * this.perRun + i]?.side);
  }

  /**
   * المزاد: who opens this question's bidding — the first question's opener
   * is drawn once, and each later المزاد question flips it (a replaced
   * question keeps its place, so its opener).
   */
  private auctionOpener(): PlayerRole {
    this.firstBidder ??= this.random() < 0.5 ? 'player1' : 'player2';
    const before = this.questions.slice(0, this.index).filter((q) => q.type === 'auction').length;
    return before % 2 === 0 ? this.firstBidder : other(this.firstBidder);
  }

  /** المزاد: the highest bidder recites, in the recital time. */
  private closeBidding(now: number) {
    const q = this.q!;
    if (!q.highBidder) return this.decide([]);
    const seconds = this.rules.rounds.auction.reciteSeconds;
    q.reciter = q.highBidder;
    q.limitSeconds = seconds;
    q.deadline = now + seconds * 1000;
  }

  /**
   * يمين يسار for one viewer: whose run, its stage and progress; results of
   * finished runs (players learn theirs only when their run is over); the
   * live run's answers and key for the referee ([full]).
   */
  private rightLeftSnapshot(full: boolean) {
    const rl = this.q!.rl!;
    const item = this.currentItem();
    const results = Object.fromEntries(
      PLAYERS.map((p) => {
        const finished = rl.done.includes(p);
        if (!finished && !full) return [p, null];
        const correct = this.rightLeftCorrect(p);
        return [p, { correct, right: correct.filter(Boolean).length, finished }];
      }),
    );
    return {
      player: rl.player,
      stage: rl.stage,
      index: rl.index,
      perRun: this.perRun,
      done: rl.done,
      results,
      ...(full && item ? { side: item.side, page: item.page, surahName: item.surahName, ayah: item.ayah } : {}),
    };
  }

  /** آية بآية: the next ayahs of the current question, in order. */
  private chain(): ChainAyah[] {
    return (this.current!.meta.chain as ChainAyah[] | undefined) ?? [];
  }

  /**
   * آية بآية for one viewer: how far the players got and the openings said
   * so far (aloud, so everyone sees them); the ayah due next for the referee
   * ([full]).
   */
  private chainSnapshot(full: boolean) {
    const q = this.q!;
    const chain = this.chain();
    const next = chain[q.step];
    return {
      step: q.step,
      length: chain.length,
      said: chain.slice(0, q.step).map((c) => c.opening),
      ...(full && next ? { next } : {}),
    };
  }

  /** Each round's clock in seconds (0 = none), from the rules. */
  private roundSeconds(type: GameQuestion['type']): number {
    const r = this.rules.rounds;
    switch (type) {
      case 'what_do_you_know':
        return 0;
      case 'ayah_number':
        return r.ayah_number.seconds;
      case 'auction':
        return r.auction.bidSeconds;
      case 'similar':
        return r.similar.slowSeconds;
      case 'sard':
        return r.sard.seconds;
      case 'ayah_by_ayah':
        return r.ayah_by_ayah.seconds;
      case 'right_left':
        return 0; // each opening has its own clock once a run starts
      case 'buzzer':
        return r.buzzer.seconds;
    }
  }

  /** المتشابهات: points by how fast the answer came. */
  private similarTiers() {
    const s = this.rules.rounds.similar;
    return [
      { withinSeconds: s.fastSeconds, points: s.fastPoints },
      { withinSeconds: s.slowSeconds, points: s.slowPoints },
    ];
  }

  private decide(awarded: PlayerRole[], points = this.basePoints()) {
    const q = this.q!;
    if (points <= 0) awarded = [];
    for (const p of awarded) this.scores[p] += points;
    q.awarded = awarded;
    q.points = awarded.length ? points : 0;
    q.phase = 'revealed';
  }

  /** A point's worth in the current round (المتشابهات: see [pointsFor]). */
  private basePoints(): number {
    const type = this.current?.type;
    if (!type || type === 'similar') return 1;
    return this.rules.rounds[type].points;
  }

  /** What a correct answer given at [at] is worth (المتشابهات tiers). */
  private pointsFor(at: number): number {
    if (this.current!.type !== 'similar') return this.basePoints();
    const seconds = (at - this.q!.startedAt) / 1000;
    return this.similarTiers().find((t) => seconds <= t.withinSeconds)?.points ?? 0;
  }

  /** The player answering now: buzzed (or handed the chance) and not yet judged. */
  private activeBuzzer(q: QuestionState): PlayerRole | null {
    const last = q.buzzes[q.buzzes.length - 1];
    return last && !q.lockedOut.includes(last) && q.phase === 'answering' ? last : null;
  }

  private firstAnswered(q: QuestionState): PlayerRole | null {
    const answered = PLAYERS.filter((p) => q.answeredAt[p] !== null);
    if (answered.length === 0) return q.buzzes[0] ?? null;
    return answered.reduce((a, b) => (q.answeredAt[b]! < q.answeredAt[a]! ? b : a));
  }

  private requireQuestion(): QuestionState {
    if (!this.q || this.status !== 'playing') throw new MatchError('no_round');
    return this.q;
  }
}
