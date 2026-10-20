# Guardians Ticket Drafts

Pick-by-pick drafts for our season ticket group (Section 146, Seats 7–10). The page has three tabs:

- **Regular season**: members draft home games one at a time. Each pick is one game with all four seats.
- **Postseason**: members draft postseason home games by seat pair (7 & 8 or 9 & 10).
- **Past drafts**: read-only results of drafts the commissioner has archived.

Both drafts run from one Google Sheet. A small Apps Script (`apps-script/Code.gs`) reads and writes it, and the page is hosted free on GitHub Pages at **https://draegs34.github.io/Guardians/**.

- Link straight to a tab: `#regular-season`, `#postseason` or `#past-drafts`.
- Until `config.js` has a script URL, the page runs in **demo mode** with sample members and the real 2027 schedule.

---

## Updating the script (do this after pulling new code)

1. In the Google Sheet, open **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with `apps-script/Code.gs` from this repo, then click **Save**.
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.
4. Reload the Google Sheet. A **Guardians Draft** menu appears.

The first time you run a menu item, Google asks for permission. It's your own script, so click *Advanced → Go to project*. It needs access to the sheet, plus permission to fetch the schedule from MLB.

---

## Moving to Firebase (optional backend upgrade)

Firebase replaces the Google Sheet as the backend:

- **Instant updates:** picks show up for everyone immediately, with no 10-second refresh and no Google "wake-up" delay.
- **Server-side rules:** Cloud Functions enforce PINs, turns, game limits and the time limit.
- **Setup screens on the site:** **Commissioner tools → Open setup** covers members, PINs, draft order, games, the MLB schedule, settings and a CSV download of picks.

The site keeps working on the Google Sheet until you switch `config.js`.

**What's in the repo:**

- `functions/`: the Cloud Functions. They use the same `engine.js` rules.
- `firestore.rules`: anyone can read the draft boards; only the functions can write, and PINs are never readable.
- `firebase.json`: deploy config.
- `live.js`: live board updates.

### A. Create the Firebase project (console.firebase.google.com)
1. **Add project.** Name it something like `guardians-draft`. Turn Google Analytics off, then click **Create**.
2. **Upgrade to the Blaze plan.** Click **Spark** (bottom left) → **Upgrade**, and add a billing account. Cloud Functions require this plan, but a group our size stays inside the free tier. Set a budget alert (e.g. $5) when it offers.
3. **Create the database.** Go to **Build → Firestore Database → Create database**. Choose a US location (e.g. `nam5`), then **Start in production mode**.
4. **Register the website.** Click ⚙️ **Project settings → General → Your apps → Web (</>)**. Name it "Draft site" (skip Firebase Hosting) and click **Register**. Keep the `firebaseConfig` values (`apiKey`, `authDomain`, `projectId`, `appId`).

### B. Deploy the backend (Terminal on your Mac, one time)
```bash
node -v                          # if this fails, install Node.js "LTS" from nodejs.org first
npm install -g firebase-tools    # add "sudo " in front if it says permission denied
firebase login
cd ~/Documents/GitHub/Guardians
firebase use --add               # pick your project, alias: default
firebase deploy --only functions,firestore
```
The deploy asks for **SETUP_KEY**. Type a private phrase you'll use once to import your data; it's not a PIN. When it finishes, it prints a **Function URL (api)**. Copy it.

### C. Export from the Google Sheet
1. Update Apps Script with the latest `apps-script/Code.gs`. This adds an export menu item, and no new deployment is needed.
2. Pause both drafts (**Draft open** = `FALSE`) so nothing changes mid-move.
3. Choose **Guardians Draft → Export everything for Firebase** and copy all of the text. It includes PINs, so don't share it.

### D. Switch the site
1. In `config.js`:
   - set `window.FIREBASE_CONFIG = { apiKey, authDomain, projectId, appId }`
   - set `window.DRAFT_API_URL` to the **api** URL from step B
   - then commit and push
2. Open the site. Each draft says it isn't set up yet. Click **Commissioner tools**, paste the export into **Import data**, enter your **setup key** and click **Import**.
3. Check both drafts, then reopen them under **Commissioner tools → Open setup → Draft open**.
4. **Season Ticket Manager:** on its Setup tab, change **Draft feed** to the new api URL. The feed returns the same data as before, and price updates keep working.

The Google Sheet then becomes a backup; nothing reads from it anymore. To change the rules later, edit `engine.js` and run `firebase deploy --only functions` again. The deploy copies `engine.js` into `functions/` automatically.

---

## Email & push alerts (Firebase only)

Members can get a message when it's their turn, even with the page closed. Each member taps **🔔 Email & push alerts**, enters their name and PIN, and chooses:

- **Email**: their address (filled in automatically when the commissioner or the Season Ticket Manager has one), an optional **second address** (e.g. a spouse's), and whether to get an email on their turn. Alerts go to both addresses.
- **Push notifications**: **Turn on for this device**, once on each phone or computer they want alerts on. On iPhone/iPad, push only works after adding the page to the Home Screen (Share → Add to Home Screen) and opening it from that icon.
- **Also tell me when I'm up next**: an extra heads-up one pick before their turn.
- **Send me a test** checks that everything works.

Push alerts are normal system notifications (lock screen, Notification Center, banners). On phones and installed apps, the Home Screen icon also shows a **1** while it's that member's turn; it clears once they've picked.

Settings are shared by both drafts and are matched by member name. The commissioner can also fill in emails on the Setup screen's **Members** table; a new address there turns email on for that member. Every email has a link back to these settings.

**From the Season Ticket Manager:** on the Manager's **Setup** tab, **Send members to draft page** opens the draft with every active member's name, email and games. A green banner appears. Open **Commissioner tools**, enter your PIN and click **Review changes**:
- **New members** (no match in either draft) are listed as *Add as a new member*. Choose which drafts to add them to. They can pick without a PIN until you set one, and in the regular season they need draft-order slots (Setup → Draft order).
- **Email changes** show the old and new address with a checkbox, so you can keep an address a member entered themselves. A member's first address turns their email alerts on.
- **Games** show the old and new count for the regular season draft (Games purchased).
- Names are matched automatically (including combined names like "Molly & Tom Jones" → Molly Jones). Use the dropdown on any row to pick a different member or skip it. Members whose details already match are listed as up to date.

Click **Apply changes** to save.

Alerts go out when a new person is on the clock (after a pick, assignment, skip, drop-out, undo or an automatic time-limit skip), and only while the draft is open. Each turn is announced once.

### One-time setup
1. **Gmail app password.** In the Gmail account the emails should come from, open **myaccount.google.com → Security → 2-Step Verification** and turn it on if it isn't already. Then go to **myaccount.google.com/apppasswords**, create one named "Ticket Draft", and copy the 16-letter password.
2. **Store it in Firebase** (Terminal, in the repo folder): `firebase functions:secrets:set GMAIL_APP_PASSWORD` and paste the password when asked. It is stored encrypted in Google Secret Manager and never goes in the repo.
3. **Push key.** Firebase console → ⚙️ **Project settings → Cloud Messaging → Web configuration → Generate key pair**. Copy the key into `window.FIREBASE_VAPID_KEY` in `config.js`. It's a public key, so it's fine in the repo.
4. **Deploy:** `firebase deploy --only functions`. The first time, it asks for **GMAIL_USER** (the Gmail address) and **SITE_URL** (press Enter to keep `https://draegs34.github.io/Guardians/`). Then commit and push the site.

Without the app password, push still works and email is skipped; without the push key, the page offers email only.

---

## Regular season draft

### Set it up (once per season)
In the sheet, choose **Guardians Draft → Set up regular season draft**. This creates five tabs and loads the schedule from MLB. Existing tabs are never overwritten.

| Tab | What it's for |
|---|---|
| **RS Settings** | Title, season, snake on/off, **Draft open** (starts `FALSE`), **Pick time limit on** (starts `FALSE`), **Pick time limit (hours)**, commissioner PIN |
| **RS Members** | Name, PIN, and **Games purchased**. Starts as a copy of the postseason list; edit it freely. Games purchased is each member's limit. |
| **RS Draft Order** | One row per draft slot. List a member **once for every 5 games** they purchased (10 games = 2 rows). A round is the number of rows (16 slots = 16 picks per round). Snake order reverses each round. |
| **RS Games** | Every home game: MLB game ID, date, day, opponent, start time (ET), promotions, notes |
| **RS Picks** | Filled in automatically. Only edit it to fix a mistake. |

**How picking works:** members pick in the order on RS Draft Order, one game per turn. A member stops getting turns once they reach their **Games purchased**. Commissioner assignments count toward that number. If games purchased isn't a multiple of 5, the member keeps picking in later rounds until they reach it.

### Keep the schedule current
Choose **Guardians Draft → Refresh regular season schedule from MLB** any time. It pulls the latest dates, opponents, start times and promotions from MLB's official data.

- Rows are matched by game ID, so picks are never affected.
- Your **Notes** are never touched.
- **Promotions** are only filled when MLB lists them, so anything you typed in yourself stays.
- As of October 2026, MLB lists all 81 home games, but start times are still TBD and promotions haven't been announced yet.

### Highlights and filters on the page
- **Home Opener**: the first home game.
- **Holidays**: Mother's Day, Memorial Day, Father's Day, the Fourth of July and Labor Day. These are highlighted with a red edge.
- **Weekday day game**: a Monday–Friday game starting before 5 PM ET, highlighted with a gold edge. These only show once MLB posts a start time.
- **Promotions** from the Promotions column, and any **Notes** (separate several with `;`).
- **Filters**: All or Available; Weekends, Weekday day games, Holidays or Promotions; Month; Opponent.

### Pick time limit (off for now)
Set **Pick time limit on** to `TRUE` and enter the hours in **Pick time limit (hours)**. The page then shows a countdown, and a member whose time runs out is skipped automatically. The log says "turn skipped (time ran out)".

- The clock starts with the first pick.
- If you pause the draft (`Draft open` = `FALSE`) for longer than the limit, turn the time limit off before reopening. Otherwise whoever is on the clock is skipped right away.
- The small gray clock icon still appears next to anyone who has been on the clock for over an hour.

---

## Postseason draft
This works the same as before, using the **Draft Settings**, **Draft Members**, **Draft Inventory** and **Draft Picks** tabs. For a brand-new sheet, choose **Guardians Draft → Set up postseason tabs**.

---

## Running a draft (both)
- **Picking**: whoever is **On the clock** taps an open game or seat pair, enters their PIN and taps **Lock it in**.
- **Picks texted to you**: make the pick for that member by entering your **Commissioner PIN** instead of theirs.
- **Updates**: the board refreshes every 10 seconds.
- **Turn alerts**: each member chooses their name under **Turn alerts on this device for**. (For alerts when the page is closed, see *Email & push alerts* above.) This is remembered per device and per draft. When it's their turn, a red banner appears, the On-the-clock card pulses and the browser tab title flashes. A blue banner shows when they're up next. There's no sound.
- **Dropping out**: the **Drop out of the draft** button. The member keeps what they've already picked and gets no more turns. If they're on the clock, it uses their turn.
- **Commissioner tools** (enter your PIN first):
  - **Assign** a game to any member. This doesn't use a turn.
  - **Skip to next member**.
  - **Undo last entry**: removes the most recent pick, assignment, skip or drop-out.
  - **Archive this draft**: click twice to confirm. This copies the picks to a new **Archive · …** tab in the sheet, clears the board so it's ready for next time, and adds the draft to **Past drafts**. Settings, members and games are left as they are.
- **Pausing**: set **Draft open** to `FALSE`.
- **Prices from the Season Ticket Manager** (postseason): opening the draft link the Manager sends (`…#prices=ALDS:432,ALCS:646,WS:1090`) shows a green banner. **Commissioner tools → Update prices from Season Ticket Manager** applies the new prices to Draft Inventory. Picks already made keep the price they were drafted at.

> **Season Ticket Manager:** its draft-feed pull reads the **postseason** draft, the same as before. Once you archive the postseason draft, the feed shows no picks. Pull the final picks into the Manager **before** archiving.

---

## For developers
- **Cache busting:** `index.html` loads `style.css`, `config.js`, `engine.js`, `live.js` and `app.js` with a `?v=` tag. Bump that number whenever you change any of those files, or phones may keep running an old cached copy.
- **Draft rules:** these live in `engine.js`. `apps-script/Code.gs` ends with an exact copy of that block, so if you change one, copy it into the other. The Firebase functions load `engine.js` directly; it's copied into `functions/` when you deploy.
- **Choosing a draft:** the script's web app takes `?draft=rs` or `?draft=post` (the default), plus `?view=archives`. POST bodies carry `"draft"`.

*Private page for our season ticket group. Not affiliated with the Cleveland Guardians or MLB.*
