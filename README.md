# almaher-server

Match server for the الماهر app: NestJS + Socket.IO, PostgreSQL for finished matches.

## Run

```
npm install
docker compose up -d          # Postgres (optional)
cp .env.example .env          # DATABASE_URL; leave it unset to keep results in memory
npm run start:dev             # http://localhost:3000
```

Try the referee screen alone: create a match in the app, then
`node scripts/demo-players.mjs <code>` joins two bot players.

## Protocol (Socket.IO, every event is acknowledged)

| Event | Who | Body |
|---|---|---|
| `match:create` | anyone | `{mode: 'same_room' \| 'remote'}` → `{ok, code}` |
| `match:join` | anyone | `{code, role: 'player1' \| 'player2' \| 'referee', name}` |
| `match:start` | referee | `{questions?: 1-10}` starts رقم الآيات |
| `round:answer` | player | `{value}` secret ayah number |
| `round:reveal` | referee | reveals and scores |
| `round:next` | referee | next question / finish |
| `referee:adjust` | referee | `{player, delta}` |

After each change every participant receives `match:state`, filtered for its role: players never
see the answer, the surah, or the other player's value before the reveal.

Scoring (رقم الآيات): a correct answer is 1 point; if nobody is correct the closest answer gets it,
both on a tie.

## Tests

```
npx jest src                               # engine rules
npx jest --config ./test/jest-e2e.json     # a full match over sockets, 3 clients
```
