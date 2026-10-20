import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import { DatabaseModule } from '../src/database/database.module';
import { MatchesModule } from '../src/matches/matches.module';
import { MatchesService } from '../src/matches/matches.service';
import { QuranModule } from '../src/quran/quran.module';
import { AuthModule } from '../src/auth/auth.module';
import { AuthService } from '../src/auth/auth.service';

describe('Dashboard API', () => {
  let app: INestApplication<App>;
  let url: string;
  const key = { 'x-admin-key': 'almaher-admin' };
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot(''), QuranModule, AuthModule, MatchesModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    url = await app.getUrl();
  });

  /** One account per test name, so a reconnect is the same player. */
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (name: string) => {
    if (!tokens.has(name)) {
      tokens.set(
        name,
        app
          .get(AuthService)
          .register(`p${tokens.size}@test.com`, 'secret1', `لاعب ${name}`)
          .then((s) => s.token),
      );
    }
    return tokens.get(name)!;
  };

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await app.close();
  });

  it('refuses requests without the admin key', async () => {
    await request(app.getHttpServer()).get('/admin/questions').expect(401);
  });

  it('generates, saves, lists and deletes questions of every type', async () => {
    const server = app.getHttpServer();
    for (const type of ['what_do_you_know', 'ayah_number', 'auction', 'similar', 'buzzer']) {
      const gen = await request(server)
        .post('/admin/questions/generate')
        .set(key)
        .send({ type, count: 2 })
        .expect(200);
      expect(gen.body).toHaveLength(2);
      expect(gen.body[0].timeLimitSeconds).toBe(60);

      const saved = await request(server).post('/admin/questions').set(key).send(gen.body[0]).expect(201);
      expect(saved.body.id).toBeDefined();
      expect(saved.body.source).toBe('generated');
    }

    const manual = await request(server)
      .post('/admin/questions')
      .set(key)
      .send({ type: 'buzzer', prompt: 'ما أطول سورة؟', answer: 'البقرة', timeLimitSeconds: 60 })
      .expect(201);
    expect(manual.body.source).toBe('manual');

    await request(server)
      .post('/admin/questions')
      .set(key)
      .send({ type: 'ayah_number', refs: [{ surah: 1, ayah: 9 }] })
      .expect(400);

    const counts = await request(server).get('/admin/questions/counts').set(key).expect(200);
    expect(counts.body.buzzer).toBe(2);

    const buzzers = await request(server).get('/admin/questions?type=buzzer').set(key).expect(200);
    expect(buzzers.body).toHaveLength(2);
    expect(buzzers.body[0].prompt).toBe('ما أطول سورة؟');

    await request(server).delete(`/admin/questions/${manual.body.id}`).set(key).expect(200);
    await request(server).delete(`/admin/questions/${manual.body.id}`).set(key).expect(404);
  });

  it('ends a live match and players receive the result', async () => {
    const connect = async (name: string) => {
      const token = await tokenFor(name);
      return new Promise<Socket>((r) => {
        const s = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
        sockets.push(s);
        s.on('connect', () => r(s));
      });
    };
    const emit = (s: Socket, e: string, b: unknown = {}) =>
      new Promise<any>((r) => s.emit(e, b, r));

    const [p1, p2] = await Promise.all([connect('أ'), connect('ب')]);
    const { code } = await emit(p1, 'match:create', {});
    await emit(p1, 'match:join', { code, role: 'player1', name: 'أ' });
    await emit(p2, 'match:join', { code, role: 'player2', name: 'ب' });

    const finished = new Promise<any>((r) =>
      p2.on('match:state', (st) => st.status === 'finished' && r(st)),
    );
    const res = await request(app.getHttpServer())
      .post(`/admin/matches/${code}/end`)
      .set(key)
      .expect(200);
    expect(res.body.winner).toBe('draw');
    expect((await finished).status).toBe('finished');

    const live = await request(app.getHttpServer()).get('/admin/matches/live').set(key);
    expect(live.body.find((m: any) => m.code === code)).toBeUndefined();
    const history = await request(app.getHttpServer()).get('/admin/matches/history').set(key);
    expect(history.body[0].code).toBe(code);

    await request(app.getHttpServer()).post(`/admin/matches/${code}/end`).set(key).expect(400);
    await request(app.getHttpServer()).post('/admin/matches/000000/end').set(key).expect(404);
  });

  const adminSocket = () =>
    new Promise<Socket>((r) => {
      const c = io(url, { transports: ['websocket'], forceNew: true, auth: { adminKey: 'almaher-admin' } });
      sockets.push(c);
      c.on('connect', () => r(c));
    });
  const emitTo = (s: Socket, e: string, b: unknown) => new Promise<any>((r) => s.emit(e, b, r));

  it('manages the rules: a round turned off is left out of new matches', async () => {
    const server = app.getHttpServer();
    const rules = await request(server).get('/admin/rules').set(key).expect(200);
    expect(rules.body.rounds.buzzer.enabled).toBe(true);
    await request(server).put('/admin/rules').send({}).expect(401);
    await request(server)
      .put('/admin/rules')
      .set(key)
      .send({ rounds: { buzzer: { points: 0 } } })
      .expect(400);
    const updated = await request(server)
      .put('/admin/rules')
      .set(key)
      .send({ questionsPerRound: 2, rounds: { buzzer: { enabled: false }, ayah_number: { points: 3 } } })
      .expect(200);
    expect(updated.body.rounds.ayah_number.points).toBe(3);
    const pub = await request(server).get('/rules').expect(200);
    expect(pub.body.enabledRounds).not.toContain('buzzer');

    const match = app.get(MatchesService).create('same_room');
    expect(match.perRound).toBe(2);
    match.join('player1', 'أ');
    match.join('player2', 'ب');
    await app.get(MatchesService).start(match);
    expect(match.questions).toHaveLength(12); // 6 rounds on × 2
    expect(match.questions.some((q) => q.type === 'buzzer')).toBe(false);

    await request(server).post('/admin/rules/reset').set(key).expect(200);
    expect(app.get(MatchesService).create('same_room').perRound).toBe(4);
  });

  it('the admin sets the question limits; new matches use them', async () => {
    const server = app.getHttpServer();
    await request(server).put('/admin/rules').set(key).send({ maxQuestions: 10 }).expect(400);
    const updated = await request(server)
      .put('/admin/rules')
      .set(key)
      .send({ maxPerRound: 40, maxQuestions: 80 })
      .expect(200);
    expect([updated.body.maxPerRound, updated.body.maxQuestions]).toEqual([40, 80]);
    const match = app.get(MatchesService).create('same_room');
    match.setRoundCounts({ what_do_you_know: 40, sard: 40 });
    expect(match.plan.map((r) => r.count)).toEqual([40, 40]);
    await request(server).post('/admin/rules/reset').set(key).expect(200);
    expect(() => app.get(MatchesService).create('same_room').setRoundCounts({ sard: 40 })).toThrow(
      'invalid_count',
    );
  });

  it('the referee prepares questions per round, publishes, and the rest is random', async () => {
    const server = app.getHttpServer();
    const { body } = await request(server).post('/admin/matches').set(key).send({}).expect(201);
    const referee = await adminSocket();
    let state: any;
    referee.on('match:state', (st: any) => (state = st));
    await emitTo(referee, 'match:join', { code: body.code, role: 'referee', name: 'الحكم' });

    const bank = await emitTo(referee, 'setup:suggest', { type: 'buzzer' });
    expect(bank.questions.length).toBeGreaterThan(0);
    const mine = { prompt: 'سؤالي', answer: 'جوابي', refs: [] };
    const set = await emitTo(referee, 'setup:set', { type: 'buzzer', questions: [mine, bank.questions[0]] });
    expect(set).toMatchObject({ ok: true });
    expect(
      (await emitTo(referee, 'setup:set', { type: 'buzzer', questions: [{ prompt: '' }] })).ok,
    ).toBe(false);
    expect(state.published).toBe(false);
    expect(state.setup.buzzer.map((q: any) => q.prompt)[0]).toBe('سؤالي');

    expect(await emitTo(referee, 'setup:publish', {})).toMatchObject({ ok: true });
    const players = await Promise.all(
      ['أ', 'ب'].map(async (n) => {
        const token = await tokenFor(n);
        const c = await new Promise<Socket>((r) => {
          const c = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
          sockets.push(c);
          c.on('connect', () => r(c));
        });
        expect(await emitTo(c, 'match:join', { code: body.code, role: 'player', name: n })).toMatchObject({ ok: true });
        return c;
      }),
    );
    expect(players).toHaveLength(2);
    expect(await emitTo(referee, 'match:start', {})).toMatchObject({ ok: true });
    const engine = app.get(MatchesService).get(body.code);
    const buzzers = engine.questions.filter((q) => q.type === 'buzzer');
    expect(buzzers[0].prompt).toBe('سؤالي');
    expect(buzzers).toHaveLength(4); // topped up at random
  });

  it('the referee picks one round with 20 questions', async () => {
    const server = app.getHttpServer();
    const { body } = await request(server).post('/admin/matches').set(key).send({}).expect(201);
    const referee = await adminSocket();
    let state: any;
    referee.on('match:state', (st: any) => (state = st));
    await emitTo(referee, 'match:join', { code: body.code, role: 'referee', name: 'الحكم' });
    expect(state.roundCounts.what_do_you_know).toBe(4);

    expect(
      (await emitTo(referee, 'setup:rounds', { counts: { what_do_you_know: 0 } })).error,
    ).toBe('no_rounds');
    expect(
      await emitTo(referee, 'setup:rounds', { counts: { what_do_you_know: 20 } }),
    ).toMatchObject({ ok: true });
    expect(state.rounds).toEqual(['what_do_you_know']);
    expect(state.roundCounts).toEqual({ what_do_you_know: 20 });

    expect(await emitTo(referee, 'setup:publish', {})).toMatchObject({ ok: true });
    for (const n of ['ج', 'د']) {
      const token = await tokenFor(n);
      const c = await new Promise<Socket>((r) => {
        const c = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
        sockets.push(c);
        c.on('connect', () => r(c));
      });
      await emitTo(c, 'match:join', { code: body.code, role: 'player', name: n });
    }
    expect(await emitTo(referee, 'match:start', {})).toMatchObject({ ok: true });
    const engine = app.get(MatchesService).get(body.code);
    expect(engine.questions).toHaveLength(20);
    expect(engine.questions.every((q) => q.type === 'what_do_you_know')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect([state.round.roundTotal, state.round.roundSize]).toEqual([1, 20]);
  });

  it('creates a match under a chosen ID that players join exactly', async () => {
    const server = app.getHttpServer();
    const res = await request(server).post('/admin/matches').set(key).send({ code: 'Final-2026' }).expect(201);
    expect(res.body.code).toBe('final-2026');
    await request(server).post('/admin/matches').set(key).send({ code: 'final-2026' }).expect(400);
    await request(server).post('/admin/matches').set(key).send({ code: 'a b' }).expect(400);

    const token = await tokenFor('تميم');
    const s = await new Promise<Socket>((r) => {
      const c = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
      sockets.push(c);
      c.on('connect', () => r(c));
    });
    // A dashboard match is a draft: players wait until the referee publishes.
    const early = await new Promise<any>((r) =>
      s.emit('match:join', { code: ' FINAL-2026 ', role: 'player', name: 'تميم' }, r),
    );
    expect(early).toEqual({ ok: false, error: 'not_published' });
    const referee = await adminSocket();
    expect(await emitTo(referee, 'match:join', { code: 'final-2026', role: 'referee', name: 'الحكم' })).toMatchObject({ ok: true });
    expect(await emitTo(referee, 'setup:publish', {})).toMatchObject({ ok: true });
    const joined = await new Promise<any>((r) =>
      s.emit('match:join', { code: ' FINAL-2026 ', role: 'player', name: 'تميم' }, r),
    );
    expect(joined).toEqual({ ok: true, role: 'player1' });

    // Arabic-Indic digits are the same ID as Western ones.
    await request(server).post('/admin/matches').set(key).send({ code: '٧٧٧' }).expect(201);
    const arabic = await new Promise<any>((r) =>
      s.emit('match:join', { code: '777', role: 'referee', name: 'ح' }, r),
    );
    expect(arabic.ok).toBe(true);
    const taken = await new Promise<any>((r) => s.emit('match:create', { code: 'final-2026' }, r));
    expect(taken).toEqual({ ok: false, error: 'code_taken' });
  });

  it('without an ID, the server matches players into the same open match', async () => {
    const connect = async (name: string) => {
      const token = await tokenFor(name);
      return new Promise<Socket>((r) => {
        const c = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
        sockets.push(c);
        c.on('connect', () => r(c));
      });
    };
    const emit = (s: Socket, e: string, b: unknown) => new Promise<any>((r) => s.emit(e, b, r));
    const [a, b, c, ref] = await Promise.all([
      connect('أ'),
      connect('ب'),
      connect('ج'),
      connect('حكم'),
    ]);

    const first = await emit(a, 'match:quick', { role: 'player', name: 'أ', mode: 'remote' });
    const second = await emit(b, 'match:quick', { role: 'player', name: 'ب', mode: 'remote' });
    expect(first).toMatchObject({ ok: true, role: 'player1' });
    expect(second).toEqual({ ok: true, role: 'player2', code: first.code });

    // That match is full, so a third player gets a new one.
    const third = await emit(c, 'match:quick', { role: 'player', name: 'ج', mode: 'remote' });
    expect(third.code).not.toBe(first.code);

    // A referee goes to the longest-waiting match without one.
    const r = await emit(ref, 'match:quick', { role: 'referee', name: 'حكم', mode: 'remote' });
    expect(r).toEqual({ ok: true, role: 'referee', code: first.code });
  });

  it('closes a match when someone stays offline too long, unless they return', async () => {
    const before = MatchesService.offlineCloseMs;
    MatchesService.offlineCloseMs = 300;
    try {
      const connect = async (name: string) => {
        const token = await tokenFor(name);
        return new Promise<Socket>((r) => {
          const c = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
          sockets.push(c);
          c.on('connect', () => r(c));
        });
      };
      const emit = (s: Socket, e: string, b: unknown) => new Promise<any>((r) => s.emit(e, b, r));
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const server = app.getHttpServer();

      // Returns in time: the match stays open.
      const [a, b] = await Promise.all([connect('أ'), connect('ب')]);
      const { code } = await emit(a, 'match:create', {});
      await emit(a, 'match:join', { code, role: 'player', name: 'أ' });
      await emit(b, 'match:join', { code, role: 'player', name: 'ب' });
      b.disconnect();
      await sleep(100);
      const b2 = await connect('ب');
      expect(await emit(b2, 'match:join', { code, role: 'player', name: 'ب' })).toEqual({
        ok: true,
        role: 'player2',
      });
      await sleep(400);
      let live = await request(server).get('/admin/matches/live').set(key);
      expect(live.body.some((m: any) => m.code === code)).toBe(true);

      // Stays away: the match closes and is saved.
      const closed = new Promise<any>((r) =>
        a.on('match:state', (st) => st.status === 'finished' && r(st)),
      );
      b2.disconnect();
      expect((await closed).status).toBe('finished');
      live = await request(server).get('/admin/matches/live').set(key);
      expect(live.body.some((m: any) => m.code === code)).toBe(false);
      const history = await request(server).get('/admin/matches/history').set(key);
      expect(history.body.some((m: any) => m.code === code)).toBe(true);
    } finally {
      MatchesService.offlineCloseMs = before;
    }
  });
});
