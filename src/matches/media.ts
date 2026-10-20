import { AccessToken } from 'livekit-server-sdk';

/**
 * Live audio/video for remote matches, on a LiveKit server (local dev:
 * `docker compose up livekit`). Each match has one room; players and the
 * referee (from the app or the dashboard) can speak and show their camera;
 * the dashboard's viewer token only watches.
 */
export const mediaConfig = () => ({
  url: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
  apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey',
  apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret',
});

export const roomFor = (code: string) => `almaher-${code}`;

/** A join token for [code]'s room as [identity] (the seat, e.g. player1). */
export async function mediaToken(
  code: string,
  identity: string,
  name: string,
  canPublish: boolean,
): Promise<{ url: string; token: string; room: string }> {
  const { url, apiKey, apiSecret } = mediaConfig();
  const room = roomFor(code);
  const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '6h' });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: false,
  });
  return { url, token: await at.toJwt(), room };
}
