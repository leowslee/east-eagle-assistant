"""One-time sign-in that lets the assistant use the assistant mailbox's Gmail, Calendar and Drive.

Run on a computer with a browser, signed in as the assistant mailbox (eileen.gu@easteagle-am.com):

    pip install google-auth-oauthlib
    python scripts/get_google_token.py client_secret.json

It writes token.json. Store its contents as the GOOGLE_TOKEN_JSON secret, then delete the file.
"""

import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python scripts/get_google_token.py client_secret.json")
    flow = InstalledAppFlow.from_client_secrets_file(sys.argv[1], SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    with open("token.json", "w") as f:
        f.write(creds.to_json())
    print("Saved token.json. Add its contents to Secret Manager as GOOGLE_TOKEN_JSON, then delete the file.")


if __name__ == "__main__":
    main()
