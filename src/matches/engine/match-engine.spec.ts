import { auctionPoints, MatchEngine, MatchError } from './match-engine';
import { GameQuestion } from './types';
import { validateRules } from '../../rules/rules.types';
import type { QuestionType } from '../../questions/question.types';

const q = (type: QuestionType, extra: Partial<GameQuestion> = {}): GameQuestion => ({
  type,
  prompt: 'سؤال',
  answer: '13',
  refs: [
    { surah: 2, ayah: 1, surahName: 'البقرة', text: 'الم' },
    { surah: 3, ayah: 1, surahName: 'آل عمران', text: 'الم' },
  ],
  timeLimitSeconds: 60,
  meta: {},
  ...extra,
});

function ready(questions: GameQuestion[]) {
  const m = new MatchEngine('123456', 'same_room', 1);
  m.random = () => 0; // player1 opens the first المزاد
  m.join('player1', 'تميم');
  m.join('player2', 'عبادة');
  m.join('referee', 'الحكم');
  m.start(questions, 0);
  return m;
}

describe('MatchEngine — flow', () => {
  it('needs both players to start', () => {
    const m = new MatchEngine('1', 'same_room');
    m.join('player1', 'a');
    expect(() => m.start([q('buzzer')], 0)).toThrow(MatchError);
  });

  it('a full match is 4 questions of each of the 5 rounds', () => {
    expect(new MatchEngine('1', 'same_room').perRound).toBe(4);
  });

  it('uses each question\'s time limit (a minute by default)', () => {
    const m = ready([q('ayah_number')]);
    expect((m.snapshotFor('player1', 0) as any).round.secondsLeft).toBe(60);
    expect(() => m.answer('player1', 13, 61_000)).toThrow('time_up');
  });

  it('moves through the questions and finishes with a winner', () => {
    const m = ready([q('buzzer'), q('buzzer')]);
    m.award('player1', 0);
    m.next(0);
    expect(m.index).toBe(1);
    m.award(null, 0);
    m.next(0);
    expect(m.status).toBe('finished');
    expect(m.winner).toBe('player1');
  });

  it('the dashboard can end a match early, keeping the scores', () => {
    const m = ready([q('buzzer')]);
    m.award('player2', 0);
    m.end();
    expect(m.winner).toBe('player2');
    expect(() => m.end()).toThrow('already_finished');
  });

  it('a player who quits a question gives the other player its points', () => {
    const m = ready([q('buzzer'), q('buzzer')]);
    m.forfeitQuestion('player1');
    expect(m.scores).toEqual({ player1: 0, player2: 1 });
    const round = (m.snapshotFor('player1', 0) as any).round;
    expect(round.phase).toBe('revealed');
    expect(round.forfeited).toBe('player1');
    expect(round.awarded).toEqual(['player2']);
    expect(() => m.forfeitQuestion('player2')).toThrow('not_answering');
    m.next(0);
    expect((m.snapshotFor('player1', 0) as any).round.forfeited).toBeNull();
  });

  it('a player who quits the match loses it, whatever the scores', () => {
    const m = ready([q('buzzer'), q('buzzer')]);
    m.award('player1', 0);
    m.forfeit('player1');
    expect(m.status).toBe('finished');
    expect(m.winner).toBe('player2');
    expect((m.snapshotFor('referee', 0) as any).forfeitedBy).toBe('player1');
    expect(() => m.forfeit('player2')).toThrow('already_finished');
  });

  it('nobody can quit a match before it starts', () => {
    const m = new MatchEngine('1', 'same_room');
    expect(() => m.forfeit('player1')).toThrow('no_round');
  });
});

describe('رقم الآيات — guess the page\'s ayah count', () => {
  it('correct scores; nobody correct → closest; equally close → both, same wrong number → none, both exact → the faster', () => {
    let m = ready([q('ayah_number', { answer: '13' })]);
    m.answer('player1', 13, 0);
    m.answer('player2', 12, 0);
    m.reveal(0);
    expect(m.scores).toEqual({ player1: 1, player2: 0 });

    m = ready([q('ayah_number', { answer: '28' })]);
    m.answer('player1', 21, 0);
    m.answer('player2', 25, 0);
    m.reveal(0);
    expect(m.scores).toEqual({ player1: 0, player2: 1 });

    m = ready([q('ayah_number', { answer: '6' })]);
    m.answer('player1', 7, 0);
    m.answer('player2', 5, 0);
    m.reveal(0);
    expect(m.scores).toEqual({ player1: 1, player2: 1 });

    m = ready([q('ayah_number', { answer: '6' })]);
    m.answer('player1', 9, 0);
    m.answer('player2', 9, 0);
    m.reveal(0);
    expect(m.scores).toEqual({ player1: 0, player2: 0 });

    // Both exact: only the faster scores.
    m = ready([q('ayah_number', { answer: '6' })]);
    m.answer('player2', 6, 4_000);
    m.answer('player1', 6, 5_000);
    m.reveal(6_000);
    expect(m.scores).toEqual({ player1: 0, player2: 1 });
  });

  it('players never see the answer or the other number before the reveal', () => {
    const m = ready([q('ayah_number')]);
    m.answer('player1', 13, 1_000);
    const p2 = m.snapshotFor('player2', 1_000) as any;
    expect(p2.round.question.answer).toBeUndefined();
    expect(p2.round.answers.player1).toEqual({ submitted: true, value: null });
    const ref = m.snapshotFor('referee', 1_000) as any;
    expect(ref.round.question.answer).toBe('13');
    expect(ref.round.answers.player1.secondsTaken).toBe(1);
    expect(ref.round.firstAnswered).toBe('player1');
  });
});

describe('ماذا تعرف — turns and strikes', () => {
  it('✓ ticks the answer off and passes the turn', () => {
    const m = ready([q('what_do_you_know')]);
    expect(m.q!.turn).toBe('player1');
    m.judge('correct', '2:1', 0);
    expect(m.q!.turn).toBe('player2');
    expect((m.snapshotFor('referee', 0) as any).round.question.refs[0].said).toBe(true);
  });

  it('the third strike gives the other player the point', () => {
    const m = ready([q('what_do_you_know')]);
    m.judge('wrong', undefined, 0); // player1: 1 strike → turn to player2
    m.judge('correct', undefined, 0); // player2 ✓ → turn to player1
    m.judge('wrong', undefined, 0); // player1: 2 strikes
    m.judge('correct', undefined, 0); // player2 ✓
    expect(m.q!.phase).toBe('answering');
    m.judge('wrong', undefined, 0); // player1: 3 strikes → player2 wins
    expect(m.q!.phase).toBe('revealed');
    expect(m.scores).toEqual({ player1: 0, player2: 2 }); // without a strike
  });

  it('a winner with no strikes earns 2, otherwise 1', () => {
    const clean = ready([q('what_do_you_know')]);
    clean.judge('wrong', undefined, 0); // player1 ✕
    clean.judge('correct', undefined, 0); // player2 ✓
    clean.judge('wrong', undefined, 0); // player1 ✕✕
    clean.judge('correct', undefined, 0);
    clean.judge('wrong', undefined, 0); // player1 out → player2, no strikes
    expect(clean.scores).toEqual({ player1: 0, player2: 2 });

    const m = ready([q('what_do_you_know')]);
    m.judge('wrong', undefined, 0); // player1 ✕
    m.judge('wrong', undefined, 0); // player2 ✕
    m.judge('wrong', undefined, 0); // player1 ✕✕
    m.judge('correct', undefined, 0);
    m.judge('wrong', undefined, 0); // player1 out → player2 had a strike
    expect(m.scores).toEqual({ player1: 0, player2: 1 });
  });

  it('each player may pass once per question, without a strike', () => {
    const m = ready([q('what_do_you_know')]);
    expect(() => m.pass('player2', 0)).toThrow('not_your_turn');
    m.pass('player1', 0);
    expect(m.q!.turn).toBe('player2');
    expect(m.q!.strikes.player1).toBe(0);
    m.judge('correct', undefined, 0); // player2 ✓ → player1
    expect(() => m.pass('player1', 0)).toThrow('already_passed');
    expect((m.snapshotFor('player1', 0).round as any).passed).toEqual(['player1']);
    m.judge('correct', undefined, 0); // player1 ✓ → player2
    m.pass('player2', 0); // player2's own one pass
    expect(m.q!.turn).toBe('player1');
  });

  it('the first turn alternates between questions', () => {
    const m = ready([q('what_do_you_know'), q('what_do_you_know')]);
    m.award(null, 0);
    m.next(0);
    expect(m.q!.turn).toBe('player2');
  });
});

describe('المزاد — open bids, then the highest bidder recites', () => {
  const auction = () => q('auction', { meta: { total: 25 } });

  it('players bid in turn: a random opener, then the other; openers alternate', () => {
    const m = ready([auction(), auction(), auction()]);
    expect(m.q!.turn).toBe('player1');
    expect(() => m.answer('player2', 2, 0)).toThrow('not_your_turn');
    m.answer('player1', 2, 0);
    expect(m.q!.turn).toBe('player2');
    m.award(null, 0);
    m.next(0);
    expect(m.q!.turn).toBe('player2'); // the next المزاد opens with the other
    m.award(null, 0);
    m.next(0);
    expect(m.q!.turn).toBe('player1');

    const drawn = new MatchEngine('1', 'same_room', 1);
    drawn.random = () => 0.9;
    drawn.join('player1', 'أ');
    drawn.join('player2', 'ب');
    drawn.start([auction()], 0);
    expect(drawn.q!.turn).toBe('player2');
  });

  it('bids are open, must beat the last one, and restart the clock', () => {
    const m = ready([auction()]);
    m.answer('player1', 3, 10_000);
    expect((m.snapshotFor('player2', 10_000) as any).round.answers.player1.value).toBe(3);
    expect(m.wakeAt(10_000)).toBe(70_000);
    expect(() => m.answer('player2', 3, 11_000)).toThrow('invalid_answer');
    expect(() => m.answer('player1', 5, 11_000)).toThrow('already_highest');
    m.answer('player2', 4, 20_000);
    expect(m.q!.highBidder).toBe('player2');
    expect(m.wakeAt(20_000)).toBe(80_000);
    m.answer('player1', 6, 30_000);
    expect(m.q!.highBidder).toBe('player1');
  });

  it('passing lets the highest bidder recite; ✓ scores', () => {
    const m = ready([auction()]);
    m.answer('player1', 3, 0);
    expect(() => m.pass('player1', 0)).toThrow('no_bid_to_pass');
    m.pass('player2', 1_000);
    expect(m.q!.reciter).toBe('player1');
    m.judge('correct', undefined, 2_000);
    expect(m.scores).toEqual({ player1: 1, player2: 0 });
  });

  it('when the bidding clock runs out the highest bidder recites; no bids → no point', () => {
    const m = ready([auction()]);
    m.answer('player1', 7, 0);
    expect(m.expire(60_000)).toBe(true);
    expect(m.q!.reciter).toBe('player1');
    m.judge('wrong', undefined, 61_000);
    expect(m.scores).toEqual({ player1: 0, player2: 1 });

    const none = ready([auction()]);
    expect(none.expire(60_000)).toBe(true);
    expect(none.q!.phase).toBe('revealed');
    expect(none.scores).toEqual({ player1: 0, player2: 0 });
  });

  it('a bid of the maximum ends the bidding; bigger bids are worth more', () => {
    const m = ready([q('auction', { meta: { total: 34 } })]);
    m.answer('player1', 34, 0);
    expect(m.q!.reciter).toBe('player1'); // player2 can no longer bid
    expect(() => m.answer('player2', 34, 0)).toThrow();
    m.judge('correct', undefined, 1_000);
    expect(m.scores).toEqual({ player1: 3, player2: 0 });
    expect([5, 19, 20, 29, 30, 41].map(auctionPoints)).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it('the reciter has 45 seconds; running out gives the opponent the point', () => {
    const m = ready([auction()]);
    m.answer('player1', 4, 0);
    m.reveal(10_000);
    const r = m.snapshotFor('referee', 10_000).round!;
    expect([r.timeLimitSeconds, r.secondsLeft]).toEqual([45, 45]);
    expect(m.wakeAt(10_000)).toBe(55_000);
    expect(m.expire(54_999)).toBe(false);
    expect(m.expire(55_000)).toBe(true);
    expect(m.scores).toEqual({ player1: 0, player2: 1 });
  });

  it('a bid cannot exceed the total', () => {
    const m = ready([auction()]);
    expect(() => m.answer('player1', 26, 0)).toThrow('invalid_answer');
  });
});

describe('المتشابهات — answer aloud, 3 strikes each', () => {
  it('either player answers; ✓ scores by the time: 3 within 15 s, 2 within 45 s', () => {
    const fast = ready([q('similar')]);
    expect(fast.snapshotFor('player1', 0).round!.timeLimitSeconds).toBe(45);
    expect(() => fast.buzz('player1', 0)).toThrow('wrong_round');
    fast.judge('correct', undefined, 15_000, 'player2');
    expect(fast.scores).toEqual({ player1: 0, player2: 3 });

    const slow = ready([q('similar')]);
    expect(slow.snapshotFor('player1', 16_000).round!.worth).toBe(2);
    slow.judge('correct', undefined, 20_000, 'player1');
    expect(slow.scores.player1).toBe(2);
    expect(slow.q!.points).toBe(2);

    const none = ready([q('similar')]);
    expect(none.wakeAt(0)).toBe(15_000); // the drop to 2 points
    expect(none.wakeAt(15_000)).toBe(45_000);
    expect(none.expire(45_000)).toBe(true);
    expect(none.scores).toEqual({ player1: 0, player2: 0 });
  });

  it('three strikes and a player may no longer answer; both out → no point', () => {
    const m = ready([q('similar')]);
    expect(() => m.judge('wrong', undefined, 0)).toThrow('invalid_player');
    for (let i = 0; i < 3; i++) m.judge('wrong', undefined, 0, 'player1');
    expect(m.q!.lockedOut).toEqual(['player1']);
    expect(() => m.judge('correct', undefined, 0, 'player1')).toThrow('locked_out');
    m.judge('wrong', undefined, 0, 'player2');
    expect(m.q!.phase).toBe('answering');
    m.judge('wrong', undefined, 0, 'player2');
    m.judge('wrong', undefined, 0, 'player2');
    expect(m.q!.phase).toBe('revealed');
    expect(m.scores).toEqual({ player1: 0, player2: 0 });
  });

  it('players see the question but not the answer until it is decided', () => {
    const m = ready([q('similar', { answer: 'البقرة' })]);
    expect((m.snapshotFor('player1', 0) as any).round.question.prompt).toBe('سؤال');
    expect((m.snapshotFor('player1', 0) as any).round.question.answer).toBeUndefined();
    m.award(null, 0);
    expect((m.snapshotFor('player1', 0) as any).round.question.answer).toBe('البقرة');
  });
});

describe('السرد — say the ayah\'s last word', () => {
  it('either player answers; 2 tries each; 30 seconds then no point', () => {
    const m = ready([q('sard', { prompt: 'الٓمٓ', answer: 'لِّلۡمُتَّقِينَ' })]);
    expect(m.snapshotFor('player1', 0).round!.timeLimitSeconds).toBe(30);
    expect((m.snapshotFor('player1', 0).round as any).maxStrikes).toBe(2);
    m.judge('wrong', undefined, 0, 'player1');
    m.judge('wrong', undefined, 0, 'player1');
    expect(m.q!.lockedOut).toEqual(['player1']);
    m.judge('correct', undefined, 10_000, 'player2');
    expect(m.scores).toEqual({ player1: 0, player2: 1 });

    const late = ready([q('sard')]);
    expect(late.wakeAt(0)).toBe(30_000);
    expect(late.expire(30_000)).toBe(true);
    expect(late.scores).toEqual({ player1: 0, player2: 0 });
  });
});

describe('آية بآية — the next ayah, in turn', () => {
  const chain = [2, 3, 4].map((n) => ({
    surah: 1,
    ayah: n,
    surahName: 'الفاتحة',
    text: `آية ${n}`,
    opening: `بداية ${n}`,
  }));
  const question = () => q('ayah_by_ayah', { meta: { chain } });

  it('turns alternate with a fresh 45 second clock; a wrong opening gives the other the point', () => {
    const m = ready([question()]);
    let r = m.snapshotFor('referee', 0).round as any;
    expect(r.timeLimitSeconds).toBe(45);
    expect(r.turn).toBe('player1');
    expect(r.chain).toEqual({ step: 0, length: 3, said: [], next: chain[0] });
    expect((m.snapshotFor('player1', 0).round as any).chain.next).toBeUndefined();
    m.judge('correct', undefined, 30_000);
    r = m.snapshotFor('player2', 30_000).round as any;
    expect(r.turn).toBe('player2');
    expect(r.secondsLeft).toBe(45);
    expect(r.chain.said).toEqual(['بداية 2']);
    m.judge('wrong', undefined, 40_000);
    expect(m.scores).toEqual({ player1: 1, player2: 0 });
  });

  it("running out of time gives the other player the point", () => {
    const m = ready([question()]);
    m.judge('correct', undefined, 0); // player2's turn, until 45s
    expect(m.wakeAt(0)).toBe(45_000);
    expect(m.expire(44_999)).toBe(false);
    expect(m.expire(45_000)).toBe(true);
    expect(m.scores).toEqual({ player1: 1, player2: 0 });
  });

  it("reaching the surah's end gives nobody the point", () => {
    const m = ready([question()]);
    for (let i = 0; i < 3; i++) m.judge('correct', undefined, 0);
    expect(m.q!.phase).toBe('revealed');
    expect(m.scores).toEqual({ player1: 0, player2: 0 });
  });
});

describe('يمين يسار — right or left page, a run each', () => {
  // 3 openings per run: player1's run gets the first 3, player2's the next 3.
  const sides = ['right', 'left', 'right', 'left', 'left', 'right'] as const;
  const rl = () =>
    q('right_left', {
      meta: {
        items: sides.map((side, i) => ({ text: `بداية ${i}`, page: i, side, surah: 1, ayah: 1, surahName: '' })),
      },
    });

  it('runs one at a time, 3 seconds each; more right answers wins', () => {
    const m = ready([rl()]);
    expect(() => m.answerSide('player1', 'right', 0)).toThrow('not_answering');
    m.startRun(0);
    expect(m.snapshotFor('player1', 0).round!.question.prompt).toBe('بداية 0');
    expect(m.wakeAt(0)).toBe(3_000);
    expect(() => m.answerSide('player2', 'right', 0)).toThrow('not_your_turn');
    m.answerSide('player1', 'right', 1_000); // ✓
    m.answerSide('player1', 'right', 2_000); // ✗
    // Player1 doesn't learn their results until the run ends.
    expect((m.snapshotFor('player1', 2_000).round as any).rightLeft.results.player1).toBeNull();
    expect(m.expire(5_000)).toBe(true); // too slow: not counted
    const after = (m.snapshotFor('player1', 5_000).round as any).rightLeft;
    expect(after.results.player1).toMatchObject({ right: 1, finished: true });
    expect(after).toMatchObject({ player: 'player2', stage: 'ready' });
    expect(m.wakeAt(5_000)).toBeNull(); // waits for the referee

    m.startRun(10_000);
    expect(m.snapshotFor('player2', 10_000).round!.question.prompt).toBe('بداية 3');
    m.answerSide('player2', 'left', 10_000); // ✓
    m.answerSide('player2', 'left', 10_500); // ✓
    m.answerSide('player2', 'left', 11_000); // ✗
    expect(m.q!.phase).toBe('revealed');
    expect(m.scores).toEqual({ player1: 0, player2: 1 });
  });

  it('a tie gives nobody the point', () => {
    const m = ready([rl()]);
    m.startRun(0);
    for (const s of ['right', 'left', 'right'] as const) m.answerSide('player1', s, 0);
    m.startRun(0);
    for (const s of ['left', 'left', 'right'] as const) m.answerSide('player2', s, 0);
    expect(m.q!.phase).toBe('revealed');
    expect(m.scores).toEqual({ player1: 0, player2: 0 });
  });
});

describe('الجرس — the buzzer', () => {
  it('first to buzz answers; ✓ scores', () => {
    const m = ready([q('buzzer')]);
    m.buzz('player2', 0);
    expect(() => m.buzz('player1', 0)).toThrow('someone_answering');
    m.judge('correct', undefined, 0);
    expect(m.scores).toEqual({ player1: 0, player2: 1 });
  });

  it('✗ shows everyone the question and hands the other player the answer; both wrong → no point', () => {
    const m = ready([q('buzzer', { prompt: 'سؤال' })]);
    m.buzz('player1', 0);
    m.judge('wrong', undefined, 0);
    expect((m.snapshotFor('player2', 0).round!.question as { prompt: string }).prompt).toBe('سؤال');
    expect((m.snapshotFor('spectator', 0).round!.question as { prompt: string }).prompt).toBe('سؤال');
    expect(m.snapshotFor('referee', 0).round!.activeBuzzer).toBe('player2');
    expect(() => m.buzz('player1', 0)).toThrow('locked_out');
    m.judge('wrong', undefined, 0);
    expect(m.q!.phase).toBe('revealed');
    expect(m.scores).toEqual({ player1: 0, player2: 0 });
  });

  it('the second player can still take the point', () => {
    const m = ready([q('buzzer')]);
    m.buzz('player2', 0);
    m.judge('wrong', undefined, 0);
    m.judge('correct', undefined, 0);
    expect(m.scores).toEqual({ player1: 1, player2: 0 });
  });
});

describe('no draws — a tie-breaker from the last round', () => {
  it('level scores after the last question add one more, until someone leads', () => {
    const m = ready([q('buzzer')]);
    m.award(null, 0);
    m.next(0, q('buzzer', { prompt: 'حسم ١' }));
    expect(m.status).toBe('playing');
    const r = m.snapshotFor('player1', 0).round as any;
    expect([r.tiebreak, r.index, r.total, r.roundIndex]).toEqual([true, 0, 1, 0]);
    m.award(null, 0); // still level
    m.next(0, q('buzzer', { prompt: 'حسم ٢' }));
    expect(m.status).toBe('playing');
    m.award('player2', 0);
    m.next(0, q('buzzer'));
    expect(m.status).toBe('finished');
    expect(m.winner).toBe('player2');
  });

  it('a leader at the end finishes the match without a tie-breaker', () => {
    const m = ready([q('buzzer')]);
    m.award('player1', 0);
    m.next(0, q('buzzer'));
    expect(m.status).toBe('finished');
    expect(m.winner).toBe('player1');
  });
});

describe('rules from the dashboard', () => {
  const custom = validateRules({
    rounds: {
      what_do_you_know: { strikes: 2 },
      buzzer: { points: 2, seconds: 20 },
      similar: { strikes: 1, fastSeconds: 10, fastPoints: 5, slowSeconds: 30, slowPoints: 1 },
      auction: { bidSeconds: 30, reciteSeconds: 20 },
    },
  });
  const start = (questions: GameQuestion[]) => {
    const m = new MatchEngine('1', 'same_room', 1, custom);
    m.random = () => 0;
    m.join('player1', 'أ');
    m.join('player2', 'ب');
    m.start(questions, 0);
    return m;
  };

  it('uses the match\'s strikes, points and timers', () => {
    const wdyk = start([q('what_do_you_know')]);
    wdyk.judge('wrong', undefined, 0);
    wdyk.judge('correct', undefined, 0);
    wdyk.judge('wrong', undefined, 0); // player1's 2nd strike ends it
    expect(wdyk.scores).toEqual({ player1: 0, player2: 2 }); // a clean win

    const buzz = start([q('buzzer')]);
    expect(buzz.snapshotFor('player1', 0).round!.timeLimitSeconds).toBe(20);
    buzz.buzz('player1', 0);
    buzz.judge('correct', undefined, 0);
    expect(buzz.scores.player1).toBe(2);

    const sim = start([q('similar')]);
    expect(sim.wakeAt(0)).toBe(10_000);
    sim.judge('wrong', undefined, 0, 'player1');
    expect(sim.q!.lockedOut).toEqual(['player1']); // 1 strike allowed
    sim.judge('correct', undefined, 5_000, 'player2');
    expect(sim.scores.player2).toBe(5);

    const auc = start([q('auction', { meta: { total: 9 } })]);
    auc.answer('player1', 2, 0);
    expect(auc.wakeAt(0)).toBe(30_000);
    auc.pass('player2', 1_000);
    expect(auc.snapshotFor('referee', 1_000).round!.timeLimitSeconds).toBe(20);
  });

  it('rejects rules out of range or with every round off', () => {
    expect(() => validateRules({ rounds: { buzzer: { points: 0 } } })).toThrow('invalid_points');
    expect(() =>
      validateRules({
        rounds: Object.fromEntries(
          [
            'what_do_you_know',
            'ayah_number',
            'auction',
            'similar',
            'sard',
            'ayah_by_ayah',
            'right_left',
            'buzzer',
          ].map((t) => [
            t,
            { enabled: false },
          ]),
        ),
      }),
    ).toThrow('no_rounds');
    expect(() => validateRules({ rounds: { similar: { fastSeconds: 50 } } })).toThrow('similar_tiers');
  });
});

describe('the referee picks the rounds and their counts', () => {
  const lobby = () => new MatchEngine('1', 'same_room');

  it('plays 4 of each round by default', () => {
    expect(lobby().plan.map((r) => r.count)).toEqual([4, 4, 4, 4, 4, 4, 4, 4]);
  });

  it('one round only, 20 questions', () => {
    const m = lobby();
    m.setRoundCounts({ what_do_you_know: 20 });
    expect(m.plan).toEqual([{ type: 'what_do_you_know', count: 20 }]);
    expect((m.snapshotFor('referee', 0) as any).rounds).toEqual(['what_do_you_know']);
  });

  it('needs at least one question, within the limits', () => {
    const m = lobby();
    expect(() => m.setRoundCounts({})).toThrow('no_rounds');
    expect(() => m.setRoundCounts({ buzzer: 0 })).toThrow('no_rounds');
    expect(() => m.setRoundCounts({ buzzer: 31 })).toThrow('invalid_count');
    expect(() => m.setRoundCounts({ buzzer: 1.5 })).toThrow('invalid_count');
    expect(() => m.setRoundCounts({ buzzer: 30, sard: 30, similar: 1 })).toThrow(
      'too_many_questions',
    );
  });

  it('the limits come from the rules', () => {
    const rules = validateRules({ maxPerRound: 25, maxQuestions: 40 });
    const m = new MatchEngine('1', 'same_room', undefined, rules);
    expect(() => m.setRoundCounts({ buzzer: 26 })).toThrow('invalid_count');
    m.setRoundCounts({ buzzer: 25, sard: 15 });
    expect(() => m.setRoundCounts({ buzzer: 25, sard: 16 })).toThrow('too_many_questions');
    expect((m.snapshotFor('referee', 0) as any).maxPerRound).toBe(25);
  });

  it('the default match must fit the limits', () => {
    expect(() => validateRules({ questionsPerRound: 5, maxPerRound: 4 })).toThrow(
      'per_round_over_limit',
    );
    // 8 rounds × 4 = 32
    expect(() => validateRules({ maxQuestions: 31 })).toThrow('match_over_limit');
    expect(validateRules({ maxQuestions: 32 }).maxQuestions).toBe(32);
  });

  it('only rounds the rules leave on', () => {
    const rules = validateRules({ rounds: { buzzer: { enabled: false } } });
    const m = new MatchEngine('1', 'same_room', undefined, rules);
    expect(() => m.setRoundCounts({ buzzer: 2 })).toThrow('round_off');
  });

  it("drops the referee's questions beyond a round's new count", () => {
    const m = lobby();
    m.setQuestions('sard', [q('sard'), q('sard'), q('sard')]);
    m.setQuestions('buzzer', [q('buzzer')]);
    m.setRoundCounts({ sard: 2 });
    expect(m.setup.sard).toHaveLength(2);
    expect(m.setup.buzzer).toBeUndefined();
    expect(() => m.setQuestions('buzzer', [q('buzzer')])).toThrow('round_off');
    expect(() => m.setQuestions('sard', [q('sard'), q('sard'), q('sard')])).toThrow(
      'too_many_questions',
    );
  });

  it('rounds of different sizes show their own position', () => {
    const m = ready([q('buzzer'), q('buzzer'), q('buzzer'), q('sard')]);
    m.next(0);
    m.next(0);
    let r = (m.snapshotFor('referee', 0) as any).round;
    expect([r.roundIndex, r.roundTotal, r.indexInRound, r.roundSize]).toEqual([0, 2, 2, 3]);
    m.next(0);
    r = (m.snapshotFor('referee', 0) as any).round;
    expect([r.roundIndex, r.indexInRound, r.roundSize]).toEqual([1, 0, 1]);
    expect(r.segments).toEqual([
      { type: 'buzzer', count: 3 },
      { type: 'sard', count: 1 },
    ]);
  });
});

describe('seats', () => {
  it('seats players in order without them choosing', () => {
    const m = new MatchEngine('1', 'same_room');
    expect(m.joinAsPlayer('أ')).toBe('player1');
    expect(m.joinAsPlayer('ب')).toBe('player2');
    expect(() => m.joinAsPlayer('ج')).toThrow('match_full');
  });

  it('gives a reconnecting player their own seat back', () => {
    const m = new MatchEngine('1', 'same_room');
    m.joinAsPlayer('أ');
    m.joinAsPlayer('ب');
    m.setConnected('player1', false);
    m.setConnected('player2', false);
    expect(m.joinAsPlayer('ب')).toBe('player2');
    expect(m.joinAsPlayer('ج')).toBe('player1');
  });
});

describe('referee tools', () => {
  it('ماذا تعرف has no timer and can be skipped while undecided', () => {
    const m = ready([q('what_do_you_know'), q('buzzer')]);
    const r = m.snapshotFor('referee', 999_999).round!;
    expect([r.timeLimitSeconds, r.secondsLeft]).toEqual([0, 0]);
    m.next(0);
    expect(m.index).toBe(1);
    expect(m.scores).toEqual({ player1: 0, player2: 0 });
  });

  it('the referee can move on from any round, undecided', () => {
    const m = ready([q('buzzer'), q('ayah_number'), q('auction')]);
    m.next(0);
    m.answer('player1', 5, 0);
    m.next(0);
    expect(m.index).toBe(2);
    expect(m.scores).toEqual({ player1: 0, player2: 0 });
  });

  it('a decided question can still be swapped; its points are taken back', () => {
    const m = ready([q('buzzer')]);
    m.buzz('player2', 0);
    m.judge('correct', undefined, 0);
    expect(m.scores.player2).toBe(1);
    m.replace(q('buzzer', { prompt: 'بديل' }), 0);
    expect(m.scores.player2).toBe(0);
    expect(m.q!.phase).toBe('answering');
    expect(m.snapshotFor('referee', 0).round!.replaced).toBe(true);
  });

  it('swaps the question for an alternative and restarts it', () => {
    const m = ready([q('what_do_you_know')]);
    m.judge('wrong', undefined, 0);
    m.replace(q('what_do_you_know', { prompt: 'بديل' }), 5_000);
    const r = m.snapshotFor('player1', 5_000).round!;
    expect(r.replaced).toBe(true);
    expect((r.question as { prompt: string }).prompt).toBe('بديل');
    expect(r.strikes).toEqual({ player1: 0, player2: 0 });
    expect(() => m.replace(q('buzzer'), 0)).toThrow('wrong_round');
  });

  it('الجرس hides the question from players until it is decided', () => {
    const m = ready([q('buzzer', { prompt: 'سؤال' })]);
    const player = m.snapshotFor('player1', 0).round!.question as Record<string, unknown>;
    expect(player.prompt).toBeNull();
    expect(player.promptHidden).toBe(true);
    expect((m.snapshotFor('referee', 0).round!.question as { prompt: string }).prompt).toBe('سؤال');
    m.buzz('player1', 0);
    m.judge('correct', undefined, 0);
    expect((m.snapshotFor('player2', 0).round!.question as { prompt: string }).prompt).toBe('سؤال');
  });
});

describe('big screen (spectator)', () => {
  it('shows what players see: no answer key, numbers hidden until revealed', () => {
    const m = ready([q('ayah_number', { answer: '7' })]);
    m.answer('player1', 7, 0);
    let view = m.snapshotFor('spectator', 0).round as any;
    expect(view.question.answer).toBeUndefined();
    expect(view.answers.player1).toMatchObject({ submitted: true, value: null });
    m.reveal(0);
    view = m.snapshotFor('spectator', 0).round as any;
    expect(view.answers.player1.value).toBe(7);
    expect(view.question.answer).toBe('7');
  });
});
