// Shared bot behaviour: answers numbers, bids, and buzzes like a player would.
export function playAsBot(socket, emit, name) {
  let handled = '';
  socket.on('match:state', (st) => {
    const r = st.round;
    if (!r || r.phase !== 'answering') return;
    const key = `${r.index}:${r.reciter ?? ''}:${r.buzzes.length}`;
    if (handled === key) return;
    handled = key;
    const delay = 1200 + Math.random() * 2500;
    const me = st.you;
    if (r.type === 'ayah_number' && !r.answers[me].submitted) {
      setTimeout(() => emit(socket, 'round:answer', { value: 5 + Math.floor(Math.random() * 12) }), delay);
    } else if (r.type === 'auction' && !r.reciter && !r.answers[me].submitted) {
      const total = Number(r.question.total ?? 10);
      setTimeout(() => emit(socket, 'round:answer', { value: 1 + Math.floor(Math.random() * Math.min(total, 8)) }), delay);
    } else if ((r.type === 'similar' || r.type === 'buzzer') && !r.activeBuzzer && !r.lockedOut.includes(me)) {
      setTimeout(() => emit(socket, 'round:buzz', {}), delay);
    }
  });
  return name;
}

/** A bot account's token: logs in, or registers it the first time. */
export async function botToken(url, name) {
  const email = `bot-${encodeURIComponent(name).replace(/%/g, '').toLowerCase()}@almaher.local`;
  const post = (path, body) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const login = await post('/auth/login', { email, password: 'bot-pass' });
  if (login.token) return login.token;
  const reg = await post('/auth/register', { email, password: 'bot-pass', name });
  if (!reg.token) throw new Error(`bot account failed: ${JSON.stringify(reg)}`);
  return reg.token;
}
