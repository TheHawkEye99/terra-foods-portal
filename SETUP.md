# Terra Foods Portal — Setup Guide

This app is a set of plain files (no build step). It needs a free Firebase
project to store data and handle logins, and it needs to be put on a web
address so your team can reach it. Follow these steps once; after that,
everything (adding products, creating staff accounts, etc.) happens inside
the app itself.

## 1. Create your Firebase project

1. Go to the [Firebase Console](https://console.firebase.google.com) and sign
   in with a Google account.
2. Click **Add project**, give it a name (e.g. "Terra Foods Portal"), and
   finish the wizard (you can decline Google Analytics — not needed).

## 2. Turn on Email/Password sign-in

1. In your new project, open **Build → Authentication** → **Get started**.
2. Under **Sign-in method**, enable **Email/Password** (the plain one, not
   the passwordless link option) → **Save**.

## 3. Create the database

1. Open **Build → Firestore Database** → **Create database**.
2. Choose a location close to you and start in **Production mode**.

## 4. Publish the security rules

1. Still in Firestore Database, click the **Rules** tab.
2. Delete what's there and paste in the entire contents of `firestore.rules`
   (in this same folder).
3. Click **Publish**.

These rules are what actually enforce who can do what (Admin/Manager/Staff/
Viewer) — the app's screens also hide buttons people shouldn't see, but the
rules are what make it stick even if someone tried to go around the app.

## 5. Connect the app to your project

1. In the Firebase Console, click the ⚙ gear next to "Project Overview" →
   **Project settings**.
2. Scroll to **Your apps** → click the **</>** (web) icon → give it any
   nickname → **Register app**. Don't check "Firebase Hosting" here unless
   you plan to use it (see step 8).
3. It will show a code block starting with `const firebaseConfig = {...}`.
   Open `firebase-config.js` in this folder and replace the placeholder
   values with the real ones from that block. This is the **only file** you
   need to edit.

## 6. Create the first Admin account

There's no account yet, so the very first one is created by hand, once:

1. **Authentication → Users → Add user.** Enter an email and password for
   yourself (the business owner) → **Add user**.
2. Click the new user in the list and copy their **User UID**.
3. Go to **Firestore Database → Data → Start collection**. Collection ID:
   `users`. Document ID: paste the UID you copied. Add these fields:
   | Field | Type | Value |
   |---|---|---|
   | `email` | string | the email you used above |
   | `displayName` | string | your name |
   | `role` | string | `admin` |
   | `active` | boolean | `true` |
   | `createdAt` | timestamp | (use "current date" if offered, or leave as any timestamp) |
4. Click **Save**.

That's it — every other account (Manager, Staff, Viewer) gets created later
from inside the app's **Users** tab by an Admin or Manager, no more manual
Firebase Console steps needed.

## 7. Put the files on the web

The whole `terra-foods-portal` folder is plain static files — upload it to
wherever you host things (your own web server, a hosting provider, etc.).
If you don't already have somewhere, the simplest option is **Firebase
Hosting**, since it's already part of the project you just created:

```
npm install -g firebase-tools
firebase login
cd terra-foods-portal
firebase init hosting     # choose your project, set "." as the public directory,
                           # answer "No" to single-page app rewrite, "No" to overwrite index.html
firebase deploy
```

That prints a live `https://your-project.web.app` address.

**Whichever host you use**, go back to **Authentication → Settings →
Authorized domains** in the Firebase Console and add that domain — Firebase
Auth refuses to log anyone in from a domain it doesn't recognize.

Opening `index.html` straight from your computer's file system (`file://…`)
will **not** work for sign-in — it has to be served over `http://` or
`https://` from a real domain (this is a Firebase Auth requirement, not
something this app can work around).

## 8. Sign in and set things up

1. Visit your site, sign in with the Admin account from step 6.
2. Go to **Backup & Settings → Import Products from a Spreadsheet** and
   upload `starter-catalog.csv` (included in this folder) — it's your
   existing 67-product catalog from the old dashboard file, ready to import
   in one click instead of retyping everything.
3. Go to **Users** and create accounts for your Manager(s) and Staff. Share
   the email + temporary password with each person directly; ask them to
   set a new password from the sidebar's "Change password" link after they
   first sign in.

## 9. Optional: Weekly Email Reports

Everything above gets you the full working portal. This step is separate and
optional — it adds automatic weekly emails (all 6 reports, as CSV
attachments) to any Admin who opts in from the sidebar. Skip this section
entirely if you don't need it; nothing else in the app depends on it.

This is the one feature in this app that needs a real server, since nothing
can email you on a schedule from just a browser tab. That means:

**9a. Upgrade to the Blaze plan**
1. Firebase Console → ⚙ (gear) → **Usage and billing** → **Details & settings** → **Modify plan** → choose **Blaze**, add a payment method.
2. Then set a safety net: Google Cloud Console → **Billing** → **Budgets & alerts** → **Create budget** → set a small threshold (e.g. $1) with an email alert. At the volume this feature runs at (a handful of emails a week, one scheduled check a day), the expected bill is $0/month — this alert just means you'd hear about it immediately if that ever changed.

**9b. Set up a Gmail App Password (the email sender)**

This project sends the weekly emails through a Gmail account using an "App Password" — a 16-character code Google generates specifically for apps like this one, separate from your real Gmail password. No domain needed.

1. Decide which Gmail address will send these (an existing one, or create a new free one dedicated to this, e.g. `terrafoodsreports@gmail.com` — keeping it separate from a personal inbox is a nice-to-have, not required).
2. That Google account needs **2-Step Verification** turned on first (required for App Passwords to even appear as an option): [myaccount.google.com/security](https://myaccount.google.com/security) → **2-Step Verification** → follow the prompts if it's not already on.
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (sign in if asked).
4. Enter a name like "Terra Foods Reports" → **Create**.
5. Google shows you a 16-character password — copy it now (spaces don't matter, it works with or without them). You won't be able to see it again after closing this screen.

*(If this is a Google Workspace/business account rather than a personal @gmail.com one, your organization's admin may have App Passwords turned off by policy — if the option doesn't appear, use a personal @gmail.com account instead.)*

**9c. Install the tools and connect this project**

From inside the `terra-foods-portal` folder:
```
npm install -g firebase-tools    # skip if you already have it
firebase login
firebase use terra-foods-portal-c567a
```

**9d. Store the App Password as a secret** (never put this in any file — it's a real secret, unlike `firebase-config.js`):
```
firebase functions:secrets:set GMAIL_APP_PASSWORD
```
Paste the 16-character password from step 9b when prompted.

**9e. Set your sending address**

Open `functions/index.js` and change the `GMAIL_ADDRESS` line near the top to the Gmail address from step 9b, e.g.:
```js
const GMAIL_ADDRESS = "terrafoodsreports@gmail.com";
```

**9f. Deploy**
```
cd functions && npm install && cd ..
firebase deploy --only functions
```

**9g. Turn it on**

Each Admin who wants the weekly emails: sidebar → **Weekly email reports** → check "Email me the weekly reports" → pick a day → **Save**. Use **Send me a test now** right away to confirm delivery without waiting for that day to come around — the first email from a new sending address quite often lands in spam, so check there too and mark it "Not spam" if so (later ones should then land normally).

Reports are sent daily at 7:00am (India time — change the `TIMEZONE` constant near the top of `functions/index.js` if your business is elsewhere) to whoever's chosen day matches that day. If you ever change `firestore.rules` after this point, you can now publish it with `firebase deploy --only firestore:rules` instead of copy-pasting into the Console, since this project is now wired up for the Firebase CLI.

Gmail caps regular accounts at ~500 recipients/day — nowhere near what this feature uses (a handful of emails a week), so this limit is essentially never a concern here.

---

## What each role can do

| | Admin | Manager | Staff | Viewer |
|---|:-:|:-:|:-:|:-:|
| View dashboard | ✅ | ✅ | ✅ | ✅ |
| View products & reports | ✅ | ✅ | products only | ✅ (read-only) |
| Add/edit products, record sales/purchases/adjustments, update expiry dates | ✅ | ✅ | entry only | ❌ |
| Delete a product, undo a ledger entry, remove a client/supplier | ✅ | ❌ | ❌ | ❌ |
| Create/delete **Staff** accounts | ✅ | ✅ | ❌ | ❌ |
| Create/edit/delete Manager/Admin/Viewer accounts | ✅ | ❌ | ❌ | ❌ |
| CSV export/import, bulk reorder threshold | ✅ | ✅ | ❌ | ❌ |
| Wipe catalog data (products/clients/suppliers) | ✅ | ✅ | ❌ | ❌ |
| Wipe the activity/sales history too | ✅ | ❌ | ❌ | ❌ |

Admin is the one parent account with unrestricted access; it's the only role
that can manage Managers, Admins, and Viewers, and the only one that can
delete an individual product or ledger entry, or clear sales history.

## Known limitations, honestly

- **Deleting a user account** removes their access to the app immediately
  (they're signed out and can no longer do anything), but it does **not**
  remove their sign-in credential from Firebase itself — that requires the
  Firebase Admin SDK (a server), which this no-backend setup doesn't use. If
  you want their login fully gone, also delete them in **Authentication →
  Users** in the Firebase Console.
- **"Change password"** requires the person to have signed in recently — if
  it fails, sign out and back in first, then try again (a standard Firebase
  security requirement).
- Staff accounts are restricted from editing cost, price, product names, and
  reorder thresholds at the database level (not just hidden buttons). They
  can still adjust stock-related counters via the app's normal recording
  flows — the security rules don't try to verify the exact math of every
  transaction, which would need a much more complex rule set than is
  reasonable for a small trusted team. Treat this the same way you'd treat
  any staff member with till access: trusted, but the activity log always
  records who did what and when, so anything unusual is traceable.

## If something goes wrong

- **"This domain is not authorized"** on sign-in → you skipped the
  Authorized Domains step (step 7).
- **"Missing or insufficient permissions"** → the rules in step 4 weren't
  published, or don't match this file anymore.
- **Blank page / console errors about `firebaseConfig`** → `firebase-config.js`
  still has placeholder values — go back to step 5.
- **Nothing syncs between two browsers/phones** → check the "Live" indicator
  at the bottom of the sidebar; if it says "Reconnecting…", check your
  internet connection — everything here is powered by a live connection to
  Firestore.
