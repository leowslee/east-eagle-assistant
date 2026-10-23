# East Eagle WhatsApp Assistant

Staff at East Eagle Asset Management message a WhatsApp Business number with office, legal and compliance tasks. The app passes each message to Claude, which works in the assistant mailbox (`eileen.gu@easteagle-am.com`): it searches and reads Gmail, drafts emails, checks and books the calendar, and reads Google Drive files. Then it replies on WhatsApp.

## How it works

```
Staff WhatsApp  ->  Meta WhatsApp Cloud API  ->  POST /webhook (Cloud Run, Hong Kong)
                                                   | check Meta's signature
                                                   | check sender is on the staff list
                                                   v
                                         Claude API (claude-opus-5-5) + tools
                                         Gmail / Calendar / Drive as the assistant mailbox
                                                   |
                    reply on WhatsApp  <-----------+---->  audit log (locked Cloud Storage bucket)
```

Controls built in:

- **Staff list.** Only numbers in `STAFF_JSON` get answers. Messages from anyone else are logged and ignored.
- **YES before anything leaves the firm.** Sending an email or a calendar invitation is never done directly by Claude. The app shows the staff member exactly what will go out and carries it out only if they reply `YES` within 30 minutes. Any other reply cancels it.
- **Send permission.** Only staff with `"can_send": true` can confirm sends. Everyone else can only draft, and drafts wait in the mailbox.
- **Audit log.** Every inbound message, reply, tool call, proposed, confirmed and cancelled action is written as a separate JSON record to a Cloud Storage bucket with a locked retention policy. Records are grouped by day (`YYYY-MM-DD/`).
- **Scope limits.** The system prompt keeps the assistant to internal admin, legal and compliance work and tells it to refuse client orders and investment advice. It treats email and document content as information, not instructions.
- **Drive is read-only.** The app can read files but can't change, share or delete them.

Staff can send `NEW` to start a fresh conversation. Conversations also restart after 4 hours of quiet.

## Code

| Path | What it does |
|---|---|
| `app/main.py` | FastAPI webhook: verification, signature check, staff check, dedupe, replies in the background |
| `app/agent.py` | System prompt, Claude tool loop, YES confirmation flow |
| `app/google_tools.py` | Gmail, Calendar and Drive calls and the tool definitions |
| `app/whatsapp.py` | WhatsApp Cloud API parsing and sending |
| `app/store.py` | Conversations and pending actions (Cloud Storage) |
| `app/audit.py` | Audit log |
| `scripts/get_google_token.py` | One-time Google sign-in for the assistant mailbox |

Tests: `pip install -r requirements-dev.txt && pytest`.

## Quick setup (Cloud Shell)

Before you start, have ready: the Anthropic API key, the WhatsApp permanent token, Phone number ID and App secret (step 6 below), and `client_secret.json` from step 4.

1. In the Google Cloud console, open Cloud Shell (the `>_` icon at the top right).
2. Run:
   ```sh
   git clone https://github.com/leowslee/east-eagle-assistant && cd east-eagle-assistant
   ```
   (GitHub asks you to sign in because the repo is private. Use a personal access token as the password.)
3. Upload `client_secret.json` into that folder (Cloud Shell menu `⋮` > Upload).
4. Run `./setup.sh YOUR_PROJECT_ID`. It asks for each key with hidden typing, walks you through Eileen's Google sign-in, asks for the staff list, deploys, and prints the webhook details for step 9.

The script does steps 1 to 3 and 5 to 8 below. Run it again at any time; it skips what already exists. The manual steps are kept below for reference.

## Setup

All Google Cloud resources go in region `asia-east2` (Hong Kong). Commands assume `gcloud` is installed and signed in.

### 1. Google Cloud project

```sh
PROJECT=east-eagle-assistant          # your project id
REGION=asia-east2
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com gmail.googleapis.com calendar-json.googleapis.com drive.googleapis.com
```

### 2. Storage buckets

```sh
gcloud storage buckets create gs://$PROJECT-state --location=$REGION --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets create gs://$PROJECT-audit --location=$REGION --uniform-bucket-level-access --public-access-prevention \
  --retention-period=7y
```

The audit bucket keeps every record for 7 years. **Locking** the retention policy makes it permanent: nobody, including you, can shorten it or delete records early. Agree the retention period with compliance first, then lock it:

```sh
gcloud storage buckets update gs://$PROJECT-audit --lock-retention-period
```

### 3. Service account for the app

```sh
gcloud iam service-accounts create assistant-runner
SA=assistant-runner@$PROJECT.iam.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-state --member=serviceAccount:$SA --role=roles/storage.objectAdmin
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-audit --member=serviceAccount:$SA --role=roles/storage.objectCreator
```

The app can add audit records but can't read, change or delete them.

### 4. Google sign-in for the assistant mailbox

1. In Google Cloud console, open **APIs & Services > OAuth consent screen**. Choose **Internal** (only easteagle-am.com accounts can use it) and fill in the app name and support email.
2. Open **Credentials > Create credentials > OAuth client ID**, choose **Desktop app**, and download the JSON as `client_secret.json`.
3. On a computer signed in to Google as `eileen.gu@easteagle-am.com`, run:
   ```sh
   pip install google-auth-oauthlib
   python scripts/get_google_token.py client_secret.json
   ```
   Approve Gmail, Calendar and Drive (read only). The script writes `token.json`.
4. Store it as a secret, then delete the local file:
   ```sh
   gcloud secrets create GOOGLE_TOKEN_JSON --data-file=token.json && rm token.json
   ```

### 5. Anthropic API key

Create a key at [console.anthropic.com](https://console.anthropic.com) (Settings > API keys) on the firm's account, and set a monthly spend limit.

```sh
printf '%s' 'sk-ant-...' | gcloud secrets create ANTHROPIC_API_KEY --data-file=-
```

### 6. WhatsApp Business (Meta)

1. In [Meta Business Suite](https://business.facebook.com) > Settings, create or pick the East Eagle business portfolio and complete **Business verification** (BR and CR documents). This can take several days.
2. At [developers.facebook.com](https://developers.facebook.com/apps), create an app of type **Business** and add the **WhatsApp** product. Meta gives you a test number to start with.
3. Under **WhatsApp > API Setup**, add the real phone number (not already on WhatsApp) and verify it by SMS or voice call. Note its **Phone number ID**.
4. For a token that doesn't expire: Business Settings > **System users** > add an admin system user, assign the app and the WhatsApp account, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`.
5. App settings > Basic: copy the **App secret**.
6. Save these as secrets, choosing any long random string for the verify token:
   ```sh
   printf '%s' 'EAAG...'         | gcloud secrets create WHATSAPP_TOKEN --data-file=-
   printf '%s' '1234567890'      | gcloud secrets create WHATSAPP_PHONE_NUMBER_ID --data-file=-
   printf '%s' 'app-secret'      | gcloud secrets create WHATSAPP_APP_SECRET --data-file=-
   printf '%s' "$(openssl rand -hex 24)" | gcloud secrets create WHATSAPP_VERIFY_TOKEN --data-file=-
   ```

### 7. Staff list

Numbers are digits with the country code (Hong Kong `852`).

```sh
cat > staff.json <<'EOF'
{"85291234567": {"name": "Leo", "can_send": true},
 "85298765432": {"name": "Eileen", "can_send": false}}
EOF
gcloud secrets create STAFF_JSON --data-file=staff.json && rm staff.json
```

To change it later, add a new version (`gcloud secrets versions add STAFF_JSON --data-file=...`) and redeploy.

### 8. Deploy

```sh
for s in ANTHROPIC_API_KEY WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN GOOGLE_TOKEN_JSON STAFF_JSON; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done

gcloud run deploy east-eagle-assistant --source . --region $REGION \
  --service-account $SA --allow-unauthenticated \
  --no-cpu-throttling --min-instances 0 --max-instances 1 --timeout 300 \
  --set-env-vars AUDIT_BUCKET=$PROJECT-audit,STATE_BUCKET=$PROJECT-state,ASSISTANT_MAILBOX=eileen.gu@easteagle-am.com \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,WHATSAPP_TOKEN=WHATSAPP_TOKEN:latest,WHATSAPP_PHONE_NUMBER_ID=WHATSAPP_PHONE_NUMBER_ID:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest,WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,GOOGLE_TOKEN_JSON=GOOGLE_TOKEN_JSON:latest,STAFF_JSON=STAFF_JSON:latest
```

`--allow-unauthenticated` is needed because Meta calls the webhook. Every request is still checked against Meta's signature, and only staff numbers are answered. `--no-cpu-throttling` lets the app finish replying after it has acknowledged Meta. `--max-instances 1` keeps each person's messages in order.

### 9. Connect the webhook

In the Meta app, **WhatsApp > Configuration > Webhook**: set the callback URL to `https://<cloud-run-url>/webhook`, the verify token to the value from step 6, then subscribe to the **messages** field.

Send `hello` from a staff number to test.

## Running costs

- Cloud Run and Cloud Storage: a few US dollars a month at this volume.
- Claude API: billed per use (Claude Opus 5.5 is US$4 per million input tokens and US$20 per million output tokens). Reading long emails and documents is the main cost. Set a spend limit in the Anthropic console.
- WhatsApp: replies within 24 hours of a staff message are free under Meta's current pricing.

## Compliance notes

These are points to raise with compliance, not legal advice.

- The audit bucket is the record of WhatsApp instructions and actions. If it is the only place these records are kept, check the SFC's requirements on external electronic data storage (circular of 31 October 2019) with compliance.
- Personal data in emails and files is sent to Anthropic (API data is not used for training) and Google. Update the staff privacy notice and internal AI use policy (PDPO, and the SFC's November 2024 circular on generative AI language models).
- Review the audit log and the staff list regularly.
