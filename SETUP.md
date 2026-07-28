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
