#!/usr/bin/env sh
# Azure App Service startup command: sh startup.sh
set -eu

exec python3 app.py
