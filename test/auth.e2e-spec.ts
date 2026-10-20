import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { DatabaseModule } from '../src/database/database.module';

describe('Accounts over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot(''), AuthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('registers, logs in, reads the profile, and rejects bad input', async () => {
    const server = app.getHttpServer();
    const reg = await request(server)
      .post('/auth/register')
      .send({ email: 'Abood@Example.com', password: 'secret1', name: 'عبود' })
      .expect(201);
    expect(reg.body.user).toMatchObject({ email: 'abood@example.com', name: 'عبود' });
    expect(typeof reg.body.token).toBe('string');

    await request(server)
      .post('/auth/register')
      .send({ email: 'abood@example.com', password: 'secret1', name: 'x2' })
      .expect(400)
      .expect((r) => expect(r.body.message).toBe('email_taken'));
    await request(server)
      .post('/auth/register')
      .send({ email: 'bad', password: 'secret1', name: 'ab' })
      .expect(400);
    await request(server)
      .post('/auth/register')
      .send({ email: 'c@d.com', password: '123', name: 'ab' })
      .expect(400)
      .expect((r) => expect(r.body.message).toBe('weak_password'));

    await request(server)
      .post('/auth/login')
      .send({ email: 'abood@example.com', password: 'wrong' })
      .expect(400)
      .expect((r) => expect(r.body.message).toBe('invalid_credentials'));
    const login = await request(server)
      .post('/auth/login')
      .send({ email: 'ABOOD@example.com', password: 'secret1' })
      .expect(200);

    const me = await request(server)
      .get('/auth/me')
      .set('authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(me.body.stats).toMatchObject({ matches: 0, wins: 0 });
    await request(server).get('/auth/me').set('authorization', 'Bearer nope').expect(401);
    await request(server).get('/leaderboard').expect(200);
  });

  it('deletes an account only with its password', async () => {
    const server = app.getHttpServer();
    const reg = await request(server)
      .post('/auth/register')
      .send({ email: 'gone@example.com', password: 'secret1', name: 'Gone' })
      .expect(201);
    const auth = `Bearer ${reg.body.token}`;
    await request(server)
      .delete('/auth/me')
      .set('authorization', auth)
      .send({ password: 'wrong' })
      .expect(400)
      .expect((r) => expect(r.body.message).toBe('invalid_credentials'));
    await request(server)
      .delete('/auth/me')
      .set('authorization', auth)
      .send({ password: 'secret1' })
      .expect(204);
    await request(server).get('/auth/me').set('authorization', auth).expect(401);
    await request(server)
      .post('/auth/login')
      .send({ email: 'gone@example.com', password: 'secret1' })
      .expect(400);
  });
});
