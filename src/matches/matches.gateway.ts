import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MatchEngine, MatchError, Side, Verdict } from './engine/match-engine';
import { MatchMode, PlayerRole, Role } from './engine/types';
import { QUESTION_TYPES, QuestionType } from '../questions/question.types';
import { MatchesService } from './matches.service';
import { AuthService } from '../auth/auth.service';
import { mediaToken } from './media';

interface SocketData {
  code?: string;
  role?: Role;
}

/** Who a socket is: a signed-in account, or the dashboard (admin key). */
type Identity = { kind: 'user'; userId: string; name: string } | { kind: 'admin' };

type Ack = { ok: true; [k: string]: unknown } | { ok: false; error: string };

const ROLES: Role[] = ['player1', 'player2', 'referee'];

/**
 * Real-time match protocol. Every action is acknowledged; after any change
 * each participant receives `match:state` filtered for their role.
 *
 * Client → server: match:create, match:quick, match:join, setup:rounds,
 * setup:bank, setup:suggest, setup:set, setup:publish, match:start,
 * round:answer, round:pass, round:side, round:start_run, round:buzz, round:judge, round:reveal, round:award,
 * round:replace, round:next, round:forfeit, match:forfeit, referee:adjust, referee:end,
 * media:token.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class MatchesGateway implements OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly matches: MatchesService,
    private readonly auth: AuthService,
  ) {}

  /**
   * The socket's identity from its handshake: `auth.token` (an account) or
   * `auth.adminKey` (the dashboard). Playing needs one of them.
   */
  private async identify(socket: Socket): Promise<Identity> {
    const auth = (socket.handshake.auth ?? {}) as { token?: string; adminKey?: string };
    if (auth.adminKey && auth.adminKey === (process.env.ADMIN_KEY ?? 'almaher-admin')) {
      return { kind: 'admin' };
    }
    const user = await this.auth.fromToken(auth.token);
    if (!user) throw new MatchError('login_required');
    return { kind: 'user', userId: user.id, name: user.name };
  }

  @SubscribeMessage('match:create')
  create(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { mode?: MatchMode; code?: string; role?: string },
  ): Promise<Ack> {
    const mode: MatchMode = body?.mode === 'remote' ? 'remote' : 'same_room';
    return this.run(async () => {
      await this.identify(socket);
      const match = this.matches.create(mode, body?.code);
      // A referee's match is a draft they prepare, then publish.
      if (body?.role === 'referee') match.published = false;
      return { code: match.code };
    });
  }

  /** Preparing: bank questions of a round to pick from. */
  @SubscribeMessage('setup:bank')
  bank(@ConnectedSocket() socket: Socket, @MessageBody() body: { type: QuestionType }) {
    return this.run(async () => {
      this.referee(socket);
      return { questions: await this.matches.bank(questionType(body?.type)) };
    });
  }

  /** Preparing: freshly generated questions of a round to pick from. */
  @SubscribeMessage('setup:suggest')
  suggest(@ConnectedSocket() socket: Socket, @MessageBody() body: { type: QuestionType }) {
    return this.run(() => {
      this.referee(socket);
      return { questions: this.matches.suggest(questionType(body?.type), 6) };
    });
  }

  /**
   * Preparing: which rounds this match plays and how many questions each,
   * e.g. `{ counts: { what_do_you_know: 20 } }` (rounds left out are skipped).
   */
  @SubscribeMessage('setup:rounds')
  setRounds(@ConnectedSocket() socket: Socket, @MessageBody() body: { counts: unknown }) {
    return this.asReferee(socket, (match) => match.setRoundCounts(body?.counts));
  }

  /** Preparing: the referee's questions for one round. */
  @SubscribeMessage('setup:set')
  setQuestions(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { type: QuestionType; questions: unknown[] },
  ) {
    return this.asReferee(socket, (match) =>
      this.matches.setQuestions(match, questionType(body?.type), body?.questions),
    );
  }

  /** Opens the prepared match to players. */
  @SubscribeMessage('setup:publish')
  publish(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => match.publish());
  }

  /**
   * Join without an ID: the server seats this player (or referee) in an open
   * match, or opens a new one for them to wait in.
   */
  @SubscribeMessage('match:quick')
  async quick(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { role: 'player' | 'referee'; name: string; mode?: MatchMode },
  ): Promise<Ack> {
    const role = body?.role === 'referee' ? 'referee' : 'player';
    const mode: MatchMode = body?.mode === 'remote' ? 'remote' : 'same_room';
    try {
      await this.identify(socket);
    } catch (e) {
      if (e instanceof MatchError) return { ok: false, error: e.code };
      throw e;
    }
    const match = this.matches.findOrCreate(role, mode);
    const ack = await this.join(socket, { code: match.code, role, name: body.name });
    return ack.ok ? { ...ack, code: match.code } : ack;
  }

  @SubscribeMessage('match:join')
  async join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { code: string; role: Role | 'player'; name: string },
  ): Promise<Ack> {
    let seat: Role | undefined;
    const ack = await this.run(async () => {
      const role = body?.role;
      if (role !== 'player' && !ROLES.includes(role)) throw new MatchError('invalid_role');
      const who = await this.identify(socket);
      // Accounts play under their own name; the dashboard names its referee.
      const name =
        who.kind === 'user' ? who.name : String(body?.name ?? '').trim().slice(0, 40);
      if (!name) throw new MatchError('name_required');
      const userId = who.kind === 'user' ? who.userId : undefined;
      const match = this.matches.get(String(body.code));
      // A finished match can't be joined; its ID is free for a new match.
      if (match.status === 'finished') throw new MatchError('match_not_found');
      // 'player' takes whichever player seat is free; a specific seat is
      // still accepted (scripts, older clients).
      if (role === 'player') {
        seat = match.joinAsPlayer(name, userId);
      } else {
        match.join(role, name, userId);
        seat = role;
      }
      const data = socket.data as SocketData;
      data.code = match.code;
      data.role = seat;
      this.matches.cancelOfflineClose(match, seat);
      await socket.join(this.room(match.code));
      await this.broadcast(match);
    });
    return ack.ok ? { ...ack, role: seat } : ack;
  }

  /**
   * Remote matches: a LiveKit token for this seat in the match's
   * audio/video room. Same-room matches have no room.
   */
  @SubscribeMessage('media:token')
  mediaToken(@ConnectedSocket() socket: Socket) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (match.mode !== 'remote') throw new MatchError('not_remote');
      const name = match.participants[role]?.name ?? role;
      return mediaToken(match.code, role, name, true);
    });
  }

  /** Referee starts the match with the rounds and counts it chose. */
  @SubscribeMessage('match:start')
  start(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => this.matches.start(match));
  }

  @SubscribeMessage('round:answer')
  answer(@ConnectedSocket() socket: Socket, @MessageBody() body: { value: number }) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (role === 'referee') throw new MatchError('players_only');
      match.answer(role, Number(body?.value), Date.now());
      await this.broadcast(match);
    });
  }

  /** المزاد: a player lets the highest bidder go ahead and recite. */
  /**
   * ماذا تعرف: the player whose turn it is passes (the referee may pass for
   * them). المزاد: a player lets the highest bidder recite.
   */
  @SubscribeMessage('round:pass')
  pass(@ConnectedSocket() socket: Socket) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (role === 'referee') {
        if (match.current?.type !== 'what_do_you_know') throw new MatchError('players_only');
        match.pass(match.q!.turn, Date.now());
      } else {
        match.pass(role, Date.now());
      }
      await this.broadcast(match);
    });
  }

  /** يمين يسار: the referee starts the waiting player's run. */
  @SubscribeMessage('round:start_run')
  startRun(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => match.startRun(Date.now()));
  }

  /** يمين يسار: the running player answers right or left. */
  @SubscribeMessage('round:side')
  side(@ConnectedSocket() socket: Socket, @MessageBody() body: { side: Side }) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (role === 'referee') throw new MatchError('players_only');
      match.answerSide(role, body?.side, Date.now());
      await this.broadcast(match);
    });
  }

  /** الجرس: a player presses the buzzer. */
  @SubscribeMessage('round:buzz')
  buzz(@ConnectedSocket() socket: Socket) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (role === 'referee') throw new MatchError('players_only');
      match.buzz(role, Date.now());
      await this.broadcast(match);
    });
  }

  /** The referee's ✓ / ✗ for the answer being given (see MatchEngine.judge). */
  @SubscribeMessage('round:judge')
  judge(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { verdict: Verdict; ref?: string; player?: PlayerRole },
  ) {
    return this.asReferee(socket, (match) => {
      if (body?.verdict !== 'correct' && body?.verdict !== 'wrong') {
        throw new MatchError('invalid_verdict');
      }
      const player =
        body.player === 'player1' || body.player === 'player2' ? body.player : undefined;
      match.judge(
        body.verdict,
        typeof body.ref === 'string' ? body.ref : undefined,
        Date.now(),
        player,
      );
    });
  }

  /** Ends the question by hand: a point to a player, or none. */
  @SubscribeMessage('round:award')
  award(@ConnectedSocket() socket: Socket, @MessageBody() body: { player: PlayerRole | null }) {
    return this.asReferee(socket, (match) => {
      const p = body?.player;
      if (p !== null && p !== 'player1' && p !== 'player2') throw new MatchError('invalid_player');
      match.award(p, Date.now());
    });
  }

  /** The referee swaps the current question for an alternative one. */
  @SubscribeMessage('round:replace')
  replace(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => this.matches.replaceQuestion(match));
  }

  @SubscribeMessage('round:reveal')
  reveal(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => match.reveal(Date.now()));
  }

  @SubscribeMessage('round:next')
  next(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => this.matches.next(match));
  }

  @SubscribeMessage('referee:adjust')
  adjust(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { player: PlayerRole; delta: number },
  ) {
    return this.asReferee(socket, (match) => {
      if (body?.player !== 'player1' && body?.player !== 'player2') {
        throw new MatchError('invalid_player');
      }
      match.adjustScore(body.player, clamp(Number(body.delta) || 0, -5, 5));
    });
  }

  /** The referee ends the match now; the current scores decide it. */
  @SubscribeMessage('referee:end')
  end(@ConnectedSocket() socket: Socket) {
    return this.asReferee(socket, (match) => match.end());
  }

  /** A player gives up the current question; the other player gets its points. */
  @SubscribeMessage('round:forfeit')
  forfeitQuestion(@ConnectedSocket() socket: Socket) {
    return this.asPlayer(socket, (match, player) => match.forfeitQuestion(player));
  }

  /** A player quits the match: it ends now and the other player wins. */
  @SubscribeMessage('match:forfeit')
  forfeit(@ConnectedSocket() socket: Socket) {
    return this.asPlayer(socket, (match, player) => match.forfeit(player));
  }

  async handleDisconnect(socket: Socket) {
    const { code, role } = socket.data as SocketData;
    if (!code || !role) return;
    try {
      const match = this.matches.get(code);
      // A newer connection may already hold this seat (a quick reconnect).
      const sockets = await this.server.in(this.room(code)).fetchSockets();
      if (sockets.some((s) => s.id !== socket.id && (s.data as SocketData).role === role)) return;
      match.setConnected(role, false);
      this.matches.scheduleOfflineClose(match, role, () => void this.broadcast(match));
      await this.broadcast(match);
    } catch {
      // Match already gone.
    }
  }

  private asReferee(socket: Socket, action: (match: MatchEngine) => void | Promise<void>) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (role !== 'referee') throw new MatchError('referee_only');
      await action(match);
      await this.broadcast(match);
    });
  }

  private asPlayer(socket: Socket, action: (match: MatchEngine, player: PlayerRole) => void) {
    return this.run(async () => {
      const { match, role } = this.context(socket);
      if (role === 'referee') throw new MatchError('players_only');
      action(match, role);
      await this.broadcast(match);
    });
  }

  private referee(socket: Socket): MatchEngine {
    const { match, role } = this.context(socket);
    if (role !== 'referee') throw new MatchError('referee_only');
    return match;
  }

  private context(socket: Socket): { match: MatchEngine; role: Role } {
    const { code, role } = socket.data as SocketData;
    if (!code || !role) throw new MatchError('not_joined');
    return { match: this.matches.get(code), role };
  }

  /** Sends each socket in the match its own role's snapshot. */
  async broadcast(match: MatchEngine) {
    const now = Date.now();
    const sockets = await this.server.in(this.room(match.code)).fetchSockets();
    for (const s of sockets) {
      const role = (s.data as SocketData).role;
      if (role) s.emit('match:state', match.snapshotFor(role, now));
    }
    this.matches.armExpiry(match, () => void this.broadcast(match));
    await this.matches.saveIfFinished(match);
  }

  /** Runs [action]; any fields it returns are added to the acknowledgement. */
  private async run(
    action: () => Promise<void | Record<string, unknown>> | void | Record<string, unknown>,
  ): Promise<Ack> {
    try {
      const extra = await action();
      return { ok: true, ...(extra ?? {}) };
    } catch (e) {
      if (e instanceof MatchError) return { ok: false, error: e.code };
      throw e;
    }
  }

  private room(code: string) {
    return `match:${code}`;
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function questionType(type: unknown): QuestionType {
  if (!QUESTION_TYPES.includes(type as QuestionType)) throw new MatchError('invalid_type');
  return type as QuestionType;
}
