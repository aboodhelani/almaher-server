// Joins an existing match as both players; the bots play every round.
//   node scripts/demo-players.mjs <code> [serverUrl]
import { io } from 'socket.io-client';
import { botToken, playAsBot } from './bots.mjs';

const [code, url = 'http://localhost:3000'] = process.argv.slice(2);
if (!code) {
  console.error('usage: node scripts/demo-players.mjs <code> [serverUrl]');
  process.exit(1);
}
const emit = (s, e, b = {}) => new Promise((r) => s.emit(e, b, r));
for (const name of ['تميم', 'عبادة']) {
  const token = await botToken(url, name);
  const s = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
  s.on('connect', async () => {
    const ack = await emit(s, 'match:join', { code, role: 'player', name });
    console.log(`${name} joined:`, ack.ok ? ack.role : ack.error);
  });
  playAsBot(s, emit, name);
}
