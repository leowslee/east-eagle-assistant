#!/usr/bin/env bash
# Sets up and deploys the assistant on Google Cloud. Run it in Cloud Shell from the repo folder:
#
#   ./setup.sh PROJECT_ID
#
# Safe to run again: it skips what already exists and only asks for missing secrets.
# To change one secret later: gcloud secrets versions add NAME --data-file=-   then run ./setup.sh again.
set -euo pipefail

PROJECT="${1:?Usage: ./setup.sh PROJECT_ID}"
REGION=asia-east2
SERVICE=east-eagle-assistant
MAILBOX="${ASSISTANT_MAILBOX:-eileen.gu@easteagle-am.com}"
SA_NAME=assistant-runner
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
STATE_BUCKET="gs://$PROJECT-state"
AUDIT_BUCKET="gs://$PROJECT-audit"

step() { printf '\n== %s\n' "$1"; }

gcloud config set project "$PROJECT" >/dev/null

step "Turning on Google Cloud services"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com gmail.googleapis.com calendar-json.googleapis.com drive.googleapis.com

step "Creating storage buckets in Hong Kong"
if ! gcloud storage buckets describe "$STATE_BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "$STATE_BUCKET" --location=$REGION --uniform-bucket-level-access --public-access-prevention
fi
if ! gcloud storage buckets describe "$AUDIT_BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "$AUDIT_BUCKET" --location=$REGION --uniform-bucket-level-access --public-access-prevention \
    --retention-period=7y
fi

step "Creating the app's service account"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create $SA_NAME --display-name="WhatsApp assistant"
fi
gcloud storage buckets add-iam-policy-binding "$STATE_BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null
gcloud storage buckets add-iam-policy-binding "$AUDIT_BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectCreator >/dev/null

secret_exists() { gcloud secrets describe "$1" >/dev/null 2>&1; }
save_secret() { gcloud secrets create "$1" --data-file=- --replication-policy=user-managed --locations=$REGION >/dev/null; }
ask_secret() {  # name, prompt
  if secret_exists "$1"; then echo "$1 already saved."; return; fi
  local value
  read -r -s -p "$2: " value; echo
  printf '%s' "$value" | save_secret "$1"
  echo "Saved $1."
}

step "Saving keys in Secret Manager (typing is hidden)"
ask_secret ANTHROPIC_API_KEY "Anthropic API key (sk-ant-...)"
ask_secret WHATSAPP_TOKEN "WhatsApp permanent access token"
ask_secret WHATSAPP_PHONE_NUMBER_ID "WhatsApp Phone number ID"
ask_secret WHATSAPP_APP_SECRET "Meta App secret"
if ! secret_exists WHATSAPP_VERIFY_TOKEN; then
  openssl rand -hex 24 | tr -d '\n' | save_secret WHATSAPP_VERIFY_TOKEN
fi

step "Google sign-in for $MAILBOX"
if secret_exists GOOGLE_TOKEN_JSON; then
  echo "GOOGLE_TOKEN_JSON already saved."
else
  if [ ! -f client_secret.json ]; then
    echo "Upload client_secret.json to this folder first (README step 4), then run ./setup.sh again."
    exit 1
  fi
  pip install --quiet --user google-auth-oauthlib
  python3 scripts/get_google_token.py client_secret.json --paste
  save_secret GOOGLE_TOKEN_JSON < token.json
  rm -f token.json client_secret.json
  echo "Saved GOOGLE_TOKEN_JSON."
fi

step "Staff list"
if secret_exists STAFF_JSON; then
  echo "STAFF_JSON already saved."
else
  echo "Enter each person as: name, WhatsApp number with country code, send (y/n). Empty line to finish."
  echo "Example: Leo, 85291234567, y"
  staff="{"
  sep=""
  while true; do
    read -r -p "> " line
    [ -z "$line" ] && break
    IFS=',' read -r name phone send <<<"$line"
    name="$(echo "$name" | xargs)"; phone="$(echo "$phone" | tr -cd '0-9')"; send="$(echo "$send" | xargs)"
    can_send=false; [[ "$send" =~ ^[Yy] ]] && can_send=true
    staff+="$sep\"$phone\": {\"name\": \"$name\", \"can_send\": $can_send}"
    sep=", "
  done
  staff+="}"
  printf '%s' "$staff" | save_secret STAFF_JSON
  echo "Saved STAFF_JSON: $staff"
fi

SECRETS=(ANTHROPIC_API_KEY WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN GOOGLE_TOKEN_JSON STAFF_JSON)
for s in "${SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
secret_flags=""
for s in "${SECRETS[@]}"; do secret_flags+="$s=$s:latest,"; done
secret_flags="${secret_flags%,}"

step "Deploying to Cloud Run (takes a few minutes)"
gcloud run deploy $SERVICE --source . --region $REGION \
  --service-account "$SA" --allow-unauthenticated \
  --no-cpu-throttling --min-instances 0 --max-instances 1 --timeout 300 \
  --set-env-vars "AUDIT_BUCKET=$PROJECT-audit,STATE_BUCKET=$PROJECT-state,ASSISTANT_MAILBOX=$MAILBOX" \
  --set-secrets "$secret_flags"

URL=$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')
step "Done. In the Meta app, open WhatsApp > Configuration > Webhook and enter:"
echo "  Callback URL:  $URL/webhook"
echo "  Verify token:  $(gcloud secrets versions access latest --secret=WHATSAPP_VERIFY_TOKEN)"
echo "Then subscribe to the 'messages' field and send 'hello' from a staff number."
