import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { DatabaseModule } from '../src/database/database.module';
import { MemoryResultsStore, RESULTS_STORE } from '../src/database/results-store';
import { MatchesModule } from '../src/matches/matches.module';
import { QuranModule } from '../src/quran/quran.module';
import { AuthModule } from '../src/auth/auth.module';
import { AuthService } from '../src/auth/auth.service';

type State = any;

describe('A full match over sockets: 7 rounds × 4 questions', () => {
  let app: INestApplication;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot(''), QuranModule, AuthModule, MatchesModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await app.close();
  });

  const connect = (auth: Record<string, string> = {}) =>
    new Promise<Socket>((resolve) => {
      const s = io(url, { transports: ['websocket'], forceNew: true, auth });
      sockets.push(s);
      s.on('connect', () => resolve(s));
    });
  const emit = (s: Socket, event: string, body?: unknown) =>
    new Promise<any>((resolve) => s.emit(event, body ?? {}, resolve));
  const ok = async (p: Promise<any>) => expect(await p).toMatchObject({ ok: true });

  it('plays all 28 questions, each round its own way, and saves the result', async () => {
    const authService = app.get(AuthService);
    const a = await authService.register('tamim@example.com', 'secret1', 'تميم');
    const b = await authService.register('obada@example.com', 'secret2', 'عبادة');

    // Without an account (or the admin key) a socket cannot play.
    const guest = await connect();
    expect((await emit(guest, 'match:quick', { role: 'player', name: 'x' })).error).toBe(
      'login_required',
    );

    const [ref, p1, p2] = await Promise.all([
      connect({ adminKey: 'almaher-admin' }),
      connect({ token: a.token }),
      connect({ token: b.token }),
    ]);
    let latest: State;
    let p2Latest: State;
    ref.on('match:state', (st: State) => (latest = st));
    p2.on('match:state', (st: State) => (p2Latest = st));
    const settle = () => new Promise((r) => setTimeout(r, 30));

    const { code } = await emit(ref, 'match:create', { mode: 'same_room' });
    await ok(emit(ref, 'match:join', { code, role: 'referee', name: 'الحكم' }));
    await ok(emit(p1, 'match:join', { code, role: 'player', name: 'تميم' }));
    await ok(emit(p2, 'match:join', { code, role: 'player', name: 'عبادة' }));
    expect((await emit(p1, 'match:start')).error).toBe('referee_only');
    await ok(emit(ref, 'match:start'));
    await settle();

    expect(latest.round.total).toBe(28);
    const seen: string[] = [];
    let expectedP1 = 0;
    let expectedP2 = 0;

    for (let i = 0; i < 28; i++) {
      const r = latest.round;
      expect(r.index).toBe(i);
      expect(r.timeLimitSeconds).toBe(
        r.type === 'similar'
          ? 45
          : r.type === 'sard'
            ? 30
            : r.type === 'what_do_you_know' || r.type === 'right_left'
              ? 0
              : 60,
      );
      seen.push(r.type);
      // Players never get the answer key during a question.
      expect(p2Latest.round.question.answer).toBeUndefined();

      switch (r.type) {
        case 'what_do_you_know': {
          // first player: strike, second: ✓, ×3 → first's third strike, second wins.
          const first = r.turn;
          await ok(emit(ref, 'round:judge', { verdict: 'wrong' }));
          await ok(emit(ref, 'round:judge', { verdict: 'correct', ref: `${r.question.refs[0].surah}:${r.question.refs[0].ayah}` }));
          await ok(emit(ref, 'round:judge', { verdict: 'wrong' }));
          await ok(emit(ref, 'round:judge', { verdict: 'correct' }));
          await ok(emit(ref, 'round:judge', { verdict: 'wrong' }));
          // The winner made no mistake: 2 points.
          if (first === 'player1') expectedP2 += 2;
          else expectedP1 += 2;
          break;
        }
        case 'ayah_number': {
          const answer = Number(r.question.answer);
          await ok(emit(p1, 'round:answer', { value: answer }));
          await ok(emit(p2, 'round:answer', { value: answer + 9 }));
          await ok(emit(ref, 'round:reveal'));
          expectedP1++;
          break;
        }
        case 'auction': {
          // Open bids in turn: the opener first, each beating the last;
          // passing lets the highest bidder recite.
          expect(p2Latest.round.question.total).toBe(r.question.meta.total);
          const bidders = { player1: p1, player2: p2 } as const;
          const opener = r.turn as 'player1' | 'player2';
          const second = opener === 'player1' ? 'player2' : 'player1';
          expect((await emit(bidders[second], 'round:answer', { value: 1 })).error).toBe('not_your_turn');
          await ok(emit(bidders[opener], 'round:answer', { value: 2 }));
          await settle();
          expect(latest.round.answers[opener].value).toBe(2);
          expect((await emit(bidders[second], 'round:answer', { value: 2 })).error).toBe('invalid_answer');
          await ok(emit(bidders[second], 'round:answer', { value: 3 }));
          await ok(emit(bidders[opener], 'round:pass'));
          await settle();
          expect(latest.round.reciter).toBe(second);
          expect(latest.round.timeLimitSeconds).toBe(45); // the recital clock
          await ok(emit(ref, 'round:judge', { verdict: 'wrong' })); // failed → opponent
          if (opener === 'player1') expectedP1++;
          else expectedP2++;
          break;
        }
        case 'similar': {
          // No buzzer: whoever answers aloud is judged; 3 strikes and out.
          expect((await emit(p1, 'round:buzz')).error).toBe('wrong_round');
          await ok(emit(ref, 'round:judge', { verdict: 'wrong', player: 'player2' }));
          await ok(emit(ref, 'round:judge', { verdict: 'correct', player: 'player1' }));
          expectedP1 += 3; // within 15 s
          break;
        }
        case 'sard': {
          // The ayah's last word, answered aloud; 2 tries each.
          await ok(emit(ref, 'round:judge', { verdict: 'wrong', player: 'player2' }));
          await ok(emit(ref, 'round:judge', { verdict: 'wrong', player: 'player2' }));
          await settle();
          expect(latest.round.lockedOut).toEqual(['player2']);
          await ok(emit(ref, 'round:judge', { verdict: 'correct', player: 'player1' }));
          expectedP1 += 1;
          break;
        }
        case 'right_left': {
          // Two runs of 6: the first runner is always right, the second
          // always wrong (the referee sees each opening's side).
          const sockets = { player1: p1, player2: p2 } as const;
          for (let run = 0; run < 2; run++) {
            await ok(emit(ref, 'round:start_run'));
            await settle();
            const runner = latest.round.rightLeft.player as 'player1' | 'player2';
            for (let k = 0; k < 6; k++) {
              const side = latest.round.rightLeft.side;
              const answer = run === 0 ? side : side === 'right' ? 'left' : 'right';
              await ok(emit(sockets[runner], 'round:side', { side: answer }));
              await settle();
            }
            if (run === 0) {
              expect(latest.round.rightLeft.results[runner]).toMatchObject({ right: 6, finished: true });
              if (runner === 'player1') expectedP1 += 1;
              else expectedP2 += 1;
            }
          }
          break;
        }
        case 'buzzer': {
          await ok(emit(p2, 'round:buzz'));
          expect((await emit(p1, 'round:buzz')).error).toBe('someone_answering');
          await settle();
          expect(p2Latest.round.question.prompt).toBeNull(); // hidden until a wrong answer
          await ok(emit(ref, 'round:judge', { verdict: 'wrong' }));
          await settle();
          expect(latest.round.activeBuzzer).toBe('player1'); // handed the answer
          expect(p2Latest.round.question.prompt).toBeTruthy(); // now shown to all
          await ok(emit(ref, 'round:judge', { verdict: 'correct' }));
          expectedP1 += 1;
          break;
        }
      }
      await settle();
      expect(latest.round.phase).toBe('revealed');
      expect(p2Latest.round.question.answer).toBeDefined(); // shown once decided
      await ok(emit(ref, 'round:next'));
      await settle();
    }

    expect(seen).toEqual([
      ...Array(4).fill('what_do_you_know'),
      ...Array(4).fill('ayah_number'),
      ...Array(4).fill('auction'),
      ...Array(4).fill('similar'),
      ...Array(4).fill('sard'),
      ...Array(4).fill('right_left'),
      ...Array(4).fill('buzzer'),
    ]);
    expect(latest.status).toBe('finished');
    expect(latest.scores).toEqual({ player1: expectedP1, player2: expectedP2 });

    const store = app.get<MemoryResultsStore>(RESULTS_STORE);
    expect(store.results.at(-1)).toMatchObject({
      code,
      player1Score: expectedP1,
      player2Score: expectedP2,
      player1UserId: a.user.id,
      player2UserId: b.user.id,
    });

    // Stats and the leaderboard come from saved results.
    const stats = await authService.stats(a.user.id);
    expect(stats).toMatchObject({ matches: 1, points: expectedP1 });
    const board = await authService.leaderboard();
    expect(board.map((r) => r.userId).sort()).toEqual([a.user.id, b.user.id].sort());
  });
});
