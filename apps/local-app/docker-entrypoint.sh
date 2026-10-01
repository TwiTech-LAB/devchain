#!/bin/sh
set -e

echo "Running database migrations..."
node -e "const { runMigrations } = require('./dist/modules/storage/db/migrate.js'); Promise.resolve(runMigrations()).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });"

echo "Starting local-app..."
exec node dist/main.js
