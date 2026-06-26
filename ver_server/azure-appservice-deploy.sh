#!/usr/bin/env sh
# Provision and deploy this directory to Azure App Service.
# Prerequisites: Azure CLI is installed and `az login` has completed.
set -eu

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <resource-group> <app-name> <location>" >&2
  exit 64
fi

RESOURCE_GROUP=$1
APP_NAME=$2
LOCATION=$3
PLAN_NAME="${APP_NAME}-plan"

: "${SEATING_ADMIN_PASSWORD:?Set SEATING_ADMIN_PASSWORD before running this script.}"
: "${SEATING_SESSION_SECRET:?Set SEATING_SESSION_SECRET before running this script.}"

az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
az appservice plan create \
  --name "$PLAN_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --sku B1 \
  --is-linux
az webapp create \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --plan "$PLAN_NAME" \
  --runtime "PYTHON:3.12"
az webapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --settings \
    SEATING_ADMIN_PASSWORD="$SEATING_ADMIN_PASSWORD" \
    SEATING_SESSION_SECRET="$SEATING_SESSION_SECRET" \
    SEATING_DB_PATH=/home/data/seating.db \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE=true
az webapp config set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --startup-file "sh startup.sh" \
  --always-on true \
  --number-of-workers 1
az webapp deploy \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --type zip \
  --src-path "$(pwd)/azure-deploy.zip"
