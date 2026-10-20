// Creates a match with two bot players and no referee, so someone (the app
// or the dashboard) can take the referee seat. Bots play every round.
//   node scripts/demo-lobby.mjs [matchId] [serverUrl]
import { io } from 'socket.io-client';
import { botToken, playAsBot } from './bots.mjs';

const id = process.argv.find((a, i) => i > 1 && !a.startsWith('http'));
const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:3000';
const connect = async (name) => {
  const token = await botToken(url, name);
  return new Promise((r) => {
    const s = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
    s.on('connect', () => r(s));
  });
};
const emit = (s, e, b = {}) => new Promise((r) => s.emit(e, b, r));

const [p1, p2] = await Promise.all([connect('تميم'), connect('عبادة')]);
const created = await emit(p1, 'match:create', { mode: 'same_room', code: id });
if (!created.ok) {
  console.error('could not create:', created.error);
  process.exit(1);
}
for (const [s, name] of [[p1, 'تميم'], [p2, 'عبادة']]) {
  await emit(s, 'match:join', { code: created.code, role: 'player', name });
  playAsBot(s, emit, name);
}
console.log(`match ${created.code} waiting for a referee`);
