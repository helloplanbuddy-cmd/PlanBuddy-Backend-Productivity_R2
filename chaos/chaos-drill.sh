#!/bin/bash

echo "🔥=================================================🔥"
echo "        PLANBUDDY CHAOS VALIDATION DRILL"
echo "🔥=================================================🔥"
echo ""
echo "WARNING: Run this ONLY against STAGING/LOCAL, NEVER PRODUCTION."
echo "This script injects hard failures into the infrastructure."
echo ""

# Configuration
COMPOSE_PROJECT="planbuddy_v9"
REDIS_CONTAINER="${COMPOSE_PROJECT}-redis-1"
DB_CONTAINER="${COMPOSE_PROJECT}-postgres-1"
WORKER_CONTAINER="${COMPOSE_PROJECT}-worker-1" # Adjust to match your actual worker container name

echo "🧪 Phase 1: The Redis Kill (Fail-Open Test)"
echo "---------------------------------------------------"
echo "Starting background load (k6) in 3 seconds..."
# Run background k6 test briefly if k6 is installed
# k6 run chaos/k6-stress-test.js & 
# K6_PID=$!
sleep 3

echo "[!] Pausing Redis container to simulate unresponsiveness..."
docker pause $REDIS_CONTAINER
echo ">>> Redis is down. App should fallback to DB constraints / fail gracefully."
echo ">>> Waiting 15 seconds..."
sleep 15
echo "[!] Unpausing Redis container..."
docker unpause $REDIS_CONTAINER
echo ">>> Redis recovered. Workers should drain backlog."
sleep 5

echo ""
echo "🧪 Phase 2: The Database Network Split (Transaction Test)"
echo "---------------------------------------------------"
echo "[!] Stopping Postgres abruptly..."
docker kill $DB_CONTAINER
echo ">>> Postgres is offline. Health checks should fail, API should return 503/500."
echo ">>> Transactions in flight MUST rollback."
echo ">>> Waiting 10 seconds..."
sleep 10
echo "[!] Starting Postgres..."
docker start $DB_CONTAINER
echo ">>> DB recovered. App should automatically reconnect."
sleep 10

echo ""
echo "🧪 Phase 3: The Worker Crash (Queue Durability Test)"
echo "---------------------------------------------------"
echo "[!] Simulating OOM kill on worker process mid-job..."
# If using PM2 inside a container, or just docker killing the worker container
if docker ps | grep -q "$WORKER_CONTAINER"; then
  docker kill $WORKER_CONTAINER
  echo ">>> Worker killed. BullMQ should mark jobs stalled and DLQ them."
  echo ">>> Waiting 10 seconds..."
  sleep 10
  docker start $WORKER_CONTAINER
  echo ">>> Worker restarted. Check logs for stalled job recovery."
else
  echo ">>> Worker container $WORKER_CONTAINER not found. Skipping."
fi

echo ""
echo "✅ CHAOS DRILL COMPLETE."
echo "Next Action: Check Prometheus/Grafana and App Logs."
echo "Verify:"
echo " 1. No double refunds occurred."
echo " 2. Webhooks pushed to DLQ were eventually processed."
echo " 3. DB connections were successfully re-established."
echo "==================================================="
