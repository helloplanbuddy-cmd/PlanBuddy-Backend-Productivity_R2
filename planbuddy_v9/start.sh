#!/bin/sh
set -e

echo "=== Starting PlanBuddy API with migrations ==="

echo "1/2 Running database migrations/check..."
node db-check.js || echo "db-check non-fatal, continuing..."

echo "2/2 Starting API server..."
exec node app.js

