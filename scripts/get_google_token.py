"""One-time sign-in that lets the assistant use the assistant mailbox's Gmail, Calendar and Drive.

    pip install google-auth-oauthlib
    python scripts/get_google_token.py client_secret.json [--paste]

Without --paste it opens a browser on this computer. With --paste (for Cloud Shell) it prints a
link: open it in a browser signed in as the assistant mailbox, approve, then copy the address of
the page you land on (it won't load; that's expected) and paste it back here.

It writes token.json. setup.sh stores it in Secret Manager and deletes the file.
"""

import os
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
]


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--paste"]
    if len(args) != 1:
        sys.exit("Usage: python scripts/get_google_token.py client_secret.json [--paste]")
    flow = InstalledAppFlow.from_client_secrets_file(args[0], SCOPES)
    if "--paste" in sys.argv:
        os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"  # the redirect is to localhost and never leaves the browser
        flow.redirect_uri = "http://localhost:8085/"
        url, _ = flow.authorization_url(prompt="consent", access_type="offline")
        print("\n1. Open this link in a browser signed in as the assistant mailbox:\n\n" + url)
        print("\n2. Approve. The browser then shows a page that can't be reached. That's expected.")
        response = input("3. Copy that page's full address from the address bar and paste it here: ").strip()
        flow.fetch_token(authorization_response=response)
        creds = flow.credentials
    else:
        creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    with open("token.json", "w") as f:
        f.write(creds.to_json())
    print("Saved token.json.")


if __name__ == "__main__":
    main()
