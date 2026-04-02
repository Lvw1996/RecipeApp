#!/bin/bash
# Plesk post-deployment script
# Runs automatically after each git pull via Plesk Git integration.
#
# In Plesk: Domains → setpixel.eu → Git → [repo] → Deployment Actions
# Set "Additional deployment actions" to: bash deploy.sh

set -e

echo "=== Installing dependencies ==="
npm install --omit=dev

echo "=== Restarting Node.js application ==="
# Plesk Node.js apps are managed by Phusion Passenger.
# Touching restart.txt signals Passenger to reload.
mkdir -p tmp
touch tmp/restart.txt

echo "=== Deploy complete ==="
