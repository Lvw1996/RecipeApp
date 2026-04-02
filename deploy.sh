#!/bin/bash
# Plesk post-deployment script
# Runs automatically after each git pull via Plesk Git integration.
#
# In Plesk: Domains → setpixel.eu → Git → [repo] → Deployment Actions
# Set "Additional deployment actions" to: bash deploy.sh

set -e

LOG=deploy.log
echo "=== Deploy started: $(date) ===" | tee -a $LOG

echo "--- Node version ---" | tee -a $LOG
node --version 2>&1 | tee -a $LOG

echo "--- npm install ---" | tee -a $LOG
npm install --omit=dev 2>&1 | tee -a $LOG

echo "--- Restarting app (Passenger) ---" | tee -a $LOG
mkdir -p tmp
touch tmp/restart.txt

echo "=== Deploy complete: $(date) ===" | tee -a $LOG
