// A live demo match for the dashboard: referee + two bots, started.
//   node scripts/demo-match.mjs [serverUrl]
import { io } from 'socket.io-client';
import { botToken, playAsBot } from './bots.mjs';

const url = process.argv[2] ?? 'http://localhost:3000';
// The referee joins with the admin key; the players with bot accounts.
const connect = async (name) => {
  const auth = name ? { token: await botToken(url, name) } : { adminKey: 'almaher-admin' };
  return new Promise((r) => {
    const s = io(url, { transports: ['websocket'], forceNew: true, auth });
    s.on('connect', () => r(s));
  });
};
const emit = (s, e, b = {}) => new Promise((r) => s.emit(e, b, r));

const [ref, p1, p2] = await Promise.all([connect(), connect('تميم'), connect('عبادة')]);
const { code } = await emit(ref, 'match:create', { mode: 'remote' });
await emit(ref, 'match:join', { code, role: 'referee', name: 'الشيخ أحمد' });
await emit(p1, 'match:join', { code, role: 'player', name: 'تميم' });
await emit(p2, 'match:join', { code, role: 'player', name: 'عبادة' });
playAsBot(p1, emit, 'تميم');
playAsBot(p2, emit, 'عبادة');
await emit(ref, 'match:start');
console.log(`match ${code} live`);
