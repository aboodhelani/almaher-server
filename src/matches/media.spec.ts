import { TokenVerifier } from 'livekit-server-sdk';
import { mediaToken, roomFor } from './media';

describe('media tokens', () => {
  it('grants the match room, publishing only when allowed', async () => {
    const player = await mediaToken('2030', 'player1', 'تميم', true);
    const viewer = await mediaToken('2030', 'viewer-1', 'لوحة', false);
    const verifier = new TokenVerifier('devkey', 'secret');
    const p = await verifier.verify(player.token);
    const v = await verifier.verify(viewer.token);
    expect(player.room).toBe(roomFor('2030'));
    expect(p.video).toMatchObject({
      room: 'almaher-2030',
      roomJoin: true,
      canPublish: true,
    });
    expect(v.video).toMatchObject({ canPublish: false, canSubscribe: true });
    expect(p.sub).toBe('player1');
  });
});
