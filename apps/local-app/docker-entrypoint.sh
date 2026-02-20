#!/bin/sh
set -e

if [ -d "/seed-skills" ]; then
  echo "Seeding skills cache from /seed-skills..."
  mkdir -p /home/node/.devchain/skills
  cp -R -n /seed-skills/. /home/node/.devchain/skills/ || true
fi

echo "Running database migrations..."
node -e "const { runMigrations } = require('./dist/modules/storage/db/migrate.js'); Promise.resolve(runMigrations()).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });"

echo "Starting local-app..."
exec node dist/main.js
