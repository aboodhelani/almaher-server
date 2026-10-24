#!/usr/bin/env bash
# Rotates the production Postgres password on Railway. Values are never
# printed; the new password is kept in .env.railway (DATABASE_PASSWORD).
#
#   ./scripts/rotate-db-password.sh            # changes it over `railway ssh`
#   ./scripts/rotate-db-password.sh --altered  # you already ran the SQL by hand
#
# Order matters: the database must accept the new password (ALTER USER)
# before Railway's variables switch to it, or the server cannot reconnect.
set -euo pipefail

cd "$(dirname "$0")/.."
FILE=.env.railway
[ -f "$FILE" ] || { echo "$FILE not found" >&2; exit 1; }

# 1. A new password, generated once and kept in .env.railway.
if ! grep -qE '^DATABASE_PASSWORD=.+' "$FILE"; then
  pw=$(openssl rand -hex 24)
  grep -q '^DATABASE_PASSWORD=' "$FILE" && sed -i '' '/^DATABASE_PASSWORD=/d' "$FILE"
  printf '\n# Postgres user "postgres" (rotated %s).\nDATABASE_PASSWORD=%s\n' "$(date +%F)" "$pw" >> "$FILE"
  echo "Generated a new database password in $FILE."
fi
pw=$(grep -E '^DATABASE_PASSWORD=' "$FILE" | cut -d= -f2-)
sql="ALTER USER postgres WITH PASSWORD '$pw';"

# 2. The database switches to it.
if [ "${1:-}" != "--altered" ]; then
  # Through the container's local socket, which needs no password; over
  # TCP, psql would log in with the variables' (possibly new) password.
  if out=$(railway ssh --service Postgres -- \
    env -u PGPASSWORD -u PGHOST -u DATABASE_URL \
    psql -h /var/run/postgresql -U postgres -d railway -v ON_ERROR_STOP=1 -qtAc "$sql" 2>&1); then
    echo "Database password changed (over railway ssh)."
  else
    echo "$out" | grep -iE 'error|fatal' | sed -E "s/PASSWORD '[^']*'/PASSWORD '***'/" >&2
    printf '%s' "$sql" | pbcopy
    cat <<EOF
Could not reach the database over railway ssh (no SSH key registered?).
The SQL command is on your clipboard. Run it in Railway:
  Postgres service → Database → Query (or Data) → paste → Run
then run:  ./scripts/rotate-db-password.sh --altered
EOF
    exit 2
  fi
fi

# 3. Railway's variables follow: Postgres's own, then the server's reference
#    (this restarts Postgres briefly and redeploys almaher-server).
railway variables --service Postgres \
  --set "POSTGRES_PASSWORD=$pw" \
  --set "PGPASSWORD=$pw" \
  --set 'DATABASE_URL=postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}' \
  >/dev/null
railway variables --service almaher-server \
  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' >/dev/null
echo "Railway variables updated; Postgres restarts and almaher-server redeploys."
