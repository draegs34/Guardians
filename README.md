# Guardians Ticket Drafts

Pick-by-pick drafts for our season ticket group (Section 146, Seats 7–10). Everything is reached from the **menu** (the ☰ button at the top left; a red dot on it means new Ticket Swap offers):

- **Drafts**
  - **Regular Season**: members draft home games one at a time. Each pick is one game with all four seats. The menu label takes its year from **Setup → Regular Season → Season**, e.g. "2027 Regular Season".
  - **Postseason**: members draft postseason home games by seat pair (7 & 8 or 9 & 10). Shown only when **Show Postseason in the menu** is ticked in Setup.
  - **Ticket Swap**: members trade regular season games with each other. See *Ticket Swap* below.
- **You**: **Who are you?** (your name, so the page highlights your games and fills in your name), and **Notification & PIN settings**.
- **Dark mode** at the bottom of the menu.
- **Help**: the member help page (`help.html`), based on the member guides.
- **Commissioner**
  - **Setup** (asks for the commissioner PIN): a section for each draft plus past drafts. See *Commissioner setup* below.
  - **Draft Tools** (commissioner tools) for the draft on screen: assign, skip, undo, Season Ticket Manager prices and archive.

On phones, the draft page's **Games / Draft Order / Pick Log / Members** bar sits above the On the clock card.

Both drafts run from one Google Sheet. A small Apps Script (`apps-script/Code.gs`) reads and writes it, and the page is hosted free on GitHub Pages at **https://draegs34.github.io/Guardians/**.

- Link straight to a page: `#regular-season`, `#postseason`, `#setup` or `#past-drafts` (Setup → Past Regular Season Drafts).
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
- **Setup screens on the site:** **Setup** covers members, PINs, draft order, games, the MLB schedule, settings, a CSV download of picks and past drafts.

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
2. Open the site and click **Setup**. Paste the export into **Import data**, enter your **setup key** and click **Import**.
3. Check both drafts, then reopen them under **Setup → Draft open**.
4. **Season Ticket Manager:** on its Setup tab, change **Draft feed** to the new api URL. The feed returns the same data as before, and price updates keep working.

The Google Sheet then becomes a backup; nothing reads from it anymore. To change the rules later, edit `engine.js` and run `firebase deploy --only functions` again. The deploy copies `engine.js` into `functions/` automatically.

---

## Commissioner setup

Open the menu, tap **Setup** and enter the commissioner PIN. It's remembered until you close the browser tab or app; **Lock** forgets it right away. Inside are four sections:

- **Regular season**: settings, **members**, draft order (with **🎲 Randomize order**), home games, the MLB schedule, a CSV of picks and **Import data**.
  - **This member list is the source of truth for both drafts.** Names, PINs and emails changed here carry over to the Postseason, and new members are added to the Postseason too (active, at the end of its order). Renaming someone keeps their picks.
  - ✕ removes a member, but only if they have no picks in either draft (undo those first).
  - The list is alphabetical by last name. Anyone you add appears at the bottom while you type and moves into place when you save.
  - **New commissioner PIN** changes the one PIN used for both drafts.
- **Postseason**: **Show Postseason in the menu** at the top (untick it to hide Postseason from members until you need a postseason draft; you can still open it with Draft Tools while Setup is unlocked), settings (now including a **pick time limit**), games & seat pairs, and the member list in draft order. Names, PINs and emails are read-only here. Use ↑ ↓ to set the order (new members start at the end), **✕** to mark someone **inactive** for the postseason (they keep any picks but get no more turns; ↺ brings them back), and **🎲 Randomize order** (active members only; inactive ones move to the end).
- **Email members their games** (bottom of the Regular Season and Postseason sections; Firebase only): after the draft, sends each checked member their own email listing the games they hold, with an optional calendar file (.ics, Cleveland times; TBD times become all-day events) and a printable PDF. You can edit the subject, message and each greeting, preview any member's email (and **View PDF**), then click **Send** twice to confirm. Emails go to the address(es) in each member's Notification & PIN settings even if their turn alerts are off; members with no address are listed but can't be selected. The subject and message are remembered, and each member shows when they were last sent their games. Test mode adds [TEST] to the subject and only uses test-mode addresses.
- **Past Regular Season Drafts** and **Past Postseason Drafts**: archived drafts of each kind. Only the commissioner can see these.

James Draeger always lands in one of the first 3 picks when either draft order is randomized. Nothing changes until you click **Save regular season** or **Save postseason**. **Hours per pick** (and the reminder fields) can only be edited when their checkbox is ticked.

**Draft Tools** (in the menu's Commissioner section) opens the commissioner tools for the draft you're looking at (from Setup, the section you're in): assign, skip, undo, Season Ticket Manager prices and **Archive this draft**. Your PIN is filled in once you've unlocked Setup.

---

## Ticket Swap

A board for trading regular season games between members. It doesn't change the draft or the Season Ticket Manager; if a trade changes who holds a game, the commissioner updates those.

- **Post a listing**: choose your name and enter your PIN, then pick:
  - **Games to trade away**: only your own upcoming games (ones you drafted or were assigned). You can choose more than one.
  - **Tickets**: 4 or 2. With 4, tick **Open to trading just 2 of the 4** if you'd split them.
  - **Looking for**: any game, or specific games.
  - **Tell me about offers by**: push notification and/or email. These need push turned on, or an email address saved, in Notification & PIN settings first. The icons on the listing show which you chose.
- **Every member with an email address gets an email** when a new listing is posted, with the details and a link. Members can turn these off in Notification & PIN settings (**Email me when someone posts a listing**).
- **Make an offer** on someone else's listing: choose which of their games you want, how many tickets (4, or 2 if they'll split), what you'd trade, a note, and how you want to hear back (push and/or email). If the lister named specific games, you can only offer those (the ones you hold); otherwise any of your games. **Other (see note)** is always there, and needs a note. The lister is alerted the way they chose.
- **Accept or Reject** each offer from **Offers** (click twice to confirm). The person who made the offer hears back the way they chose; an acceptance includes the lister's email so they can arrange the swap. Accepted games come off the listing, and when none are left it's marked fulfilled.
- **Offers are private**: only the lister (and the commissioner) can see them; everyone else sees just a count. The lister sees each offer with an **Email** button to reply.
- **New offers** on your listings show as a red dot on the menu button and a red number next to Ticket Swap in the menu (in the browser you posted from). They clear when you open **Offers**.
- **Edit** (your own listings) changes any detail, and has **Mark fulfilled** and **Remove listing**. With Setup unlocked, the commissioner can edit or remove anyone's listing.
- Games that have been played drop off listings automatically, and a listing disappears once all its games have passed.

---

## Notification settings (Firebase only)

Members can get a message when it's their turn, even with the page closed. Each member opens the menu and taps **Notification & PIN settings** (also a button on the Ticket Swap page), enters their name and PIN, and chooses:

- **In this browser**: on-screen alerts while the page is open (a banner, a flashing browser tab and the icon badge). This replaces the old *Turn alerts on this device for* dropdown, covers both drafts, and is on by default.

- **Email**: their address (filled in automatically when the commissioner or the Season Ticket Manager has one), an optional **second address** (e.g. a spouse's), and whether to get an email on their turn. Alerts go to both addresses.
- **Push notifications**: **Turn on for this device**, once on each phone or computer they want alerts on. On iPhone/iPad, push only works after adding the page to the Home Screen (Share → Add to Home Screen) and opening it from that icon.
- **Also tell me when I'm up next**: an extra heads-up one pick before their turn.
- **Send me a test** checks that everything works.

Push alerts are normal system notifications (lock screen, Notification Center, banners). On phones and installed apps, the Home Screen icon also shows a **1** while it's that member's turn; it clears once they've picked.

Settings are shared by both drafts and are matched by member name. The commissioner can also fill in emails on the Setup screen's **Members** table; a new address there turns email on for that member. Every email has a link back to these settings.

**From the Season Ticket Manager:** on the Manager's **Setup** tab, **Send members to draft page** opens the draft with every active member's name, email and games. A green banner appears and the page opens **Setup → Regular season** (enter your PIN if asked), with the changes listed at the top:
- **New members** (no match in either draft) are listed as *Add as a new member*. Choose which drafts to add them to. They can pick without a PIN until you set one, and in the regular season they need draft-order slots (Setup → Draft order).
- **Email changes** show the old and new address with a checkbox, so you can keep an address a member entered themselves. A member's first address turns their email alerts on.
- **Games** show the old and new count for the regular season draft (Games purchased).
- Names are matched automatically (including combined names like "Molly & Tom Jones" → Molly Jones). Use the dropdown on any row to pick a different member or skip it. Members whose details already match are listed as up to date.

Click **Apply changes** to save.

Alerts go out when a new person is on the clock (after a pick, assignment, skip, drop-out, undo or an automatic time-limit skip), and only while the draft is open. Each turn is announced once.

### Junior members
Regular season only (juniors aren't on the Postseason list). In **Setup → Regular season → Members**, set **Junior of** to the full member a junior shares tickets with. Juniors have their own PIN and email but no games or draft-order slots; anything they pick counts toward that full member. Then in **Settings**, tick **Junior member rounds** and tap the rounds each junior drafts. In those rounds the junior is on the clock in place of their full member, gets the turn alerts, and shows as *Junior JR (Full member)* in Up Next and *Junior JR for Full member* in the pick log. The junior's PIN or the full member's PIN works for those picks. Rounds after a full member's last pick are skipped.

### Follow-up reminders
In **Setup → Regular season** (or **Postseason**) **→ Settings**, tick **Follow-up reminders**, then set **Every … hours** and **Up to … times per turn**. Each draft has its own setting. If someone is still on the clock that many hours after their last alert, they get a reminder, using the email and/or push choices they made. Reminders stop once they pick (or their turn is skipped), are never sent to anyone who has dropped out, pause while the draft is paused, and start over for each new turn. **Quiet hours:** no reminders from 11 PM to 8 AM Eastern; one that comes due overnight goes out at 8 AM (change `QUIET_START` / `QUIET_END` in `functions/index.js`). The server checks every 10 minutes.

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

**Randomize the order (Firebase setup screen):** in **Setup → Draft order**, **🎲 Randomize order** shuffles the slots (or builds them from Games purchased if there are none). Every slot is placed at random, except that James Draeger always gets one of the first 3 picks. Click again for a new order; nothing is saved until you click **Save setup**.

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
- **Filters**: All games, Available or My games; Opponent.
- **Phones and small tablets**: the draft page has a bar (above the On the clock card) for **Games**, **Draft Order** (Up next and, in the postseason, the drop-out button), **Pick Log** and **Members**. It jumps to Games when it becomes your turn (if on-screen alerts are on). Computers show everything side by side.
- **Months fold up** (List view): tap a month's bar to open or close it. Months start folded unless a filter is on. **Expand all / Collapse all** is next to the game count.

### Pick time limit (off for now)
Set **Pick time limit on** to `TRUE` and enter the hours in **Pick time limit (hours)**. The page then shows a countdown, and a member whose time runs out is skipped automatically. The log says "turn skipped (time ran out)".

- The clock starts with the first pick.
- If you pause the draft (`Draft open` = `FALSE`) for longer than the limit, turn the time limit off before reopening. Otherwise whoever is on the clock is skipped right away.
- The small gray clock icon still appears next to anyone who has been on the clock for over an hour.

---

**List or Calendar:** above the filters on the regular season board, members can switch between the Calendar (the default, laid out like the printed schedule) and the List. In the calendar, open games are navy with the start time, taken games gray with the holder's last name, and your own games green. Tap a navy game to pick it. On phones, the List puts the **Pick** button beside each open game. The filters apply to both views (games that don't match fade out in the calendar). Each browser remembers the choice.

## Postseason draft
This works the same as before, using the **Draft Settings**, **Draft Members**, **Draft Inventory** and **Draft Picks** tabs. For a brand-new sheet, choose **Guardians Draft → Set up postseason tabs**.

---

## Running a draft (both)
- **Picking**: whoever is **On the clock** taps an open game or seat pair, enters their PIN and taps **Lock it in**.
- **Picks texted to you**: make the pick for that member by entering your **Commissioner PIN** instead of theirs.
- **Updates**: the board refreshes every 10 seconds.
- **Turn alerts**: under **Notification & PIN settings** (in the menu), each member can turn on on-screen alerts for this device. When it's their turn, a red banner appears, the On-the-clock card pulses and the browser tab title flashes. A blue banner shows when they're up next. There's no sound.
- **Dropping out** (postseason only): the **Drop out of the draft** button. The member keeps what they've already picked and gets no more turns. If they're on the clock, it uses their turn.
- **Commissioner tools** (**Draft Tools** in the menu; enter your PIN if it isn't filled in):
  - **Assign** a game to any member. This doesn't use a turn.
  - **Skip to next member**.
  - **Undo last entry**: removes the most recent pick, assignment, skip or drop-out.
  - **Archive this draft**: click twice to confirm. This saves the picks, clears the board so it's ready for next time, and adds the draft to **Setup → Past drafts**. Settings, members and games are left as they are.
- **Pausing**: set **Draft open** to `FALSE`.
- **Prices from the Season Ticket Manager** (postseason): opening the draft link the Manager sends (`…#prices=ALDS:432,ALCS:646,WS:1090`) shows a green banner. **Review & apply** opens Commissioner tools with **Update prices from Season Ticket Manager**, which applies the new prices to Draft Inventory. Picks already made keep the price they were drafted at.

> **Season Ticket Manager:** its draft-feed pull reads the **postseason** draft, the same as before. Once you archive the postseason draft, the feed shows no picks. Pull the final picks into the Manager **before** archiving.

---

## Test mode

Open the site with `?test` on the end (https://draegs34.github.io/Guardians/?test) to use a separate test copy of everything. A thin yellow "Test Mode" stripe across the top shows you're in test mode, and the tab and Home Screen icon are a yellow ticket.

- The test draft is loaded with the 2026 season games shifted to 2027 dates, each already assigned to its 2026 owner (Bill Thoburn in place of Marty Jones, Marie Thompson in place of Chris Koehler). Nine games are left open so you can try picking: the order starts Sean DeCrane, Lauren Falcone, Colleen Draeger (a test member with 5 games, PIN 1234, alerts to colleenedraeger@gmail.com), then Andrew Hanigosky, Steve Hanigosky, Bill Thoburn, Matt Jones, Marie Thompson and Mike Smith.
- Test PINs: every member is 1234, commissioner is 0000.
- Test mode has its own drafts, notification settings, Ticket Swap listings and past drafts. Nothing you do there touches the real site.
- Emails and push alerts only go to addresses and devices that were set up while in test mode, and are marked [TEST].
- To start over, open Setup → Regular Season and click **Reset test data** (twice to confirm).
- Test mode remembers who you are separately from the real site, so testing as another member doesn't change the real site.
- To open the site as a brand-new visitor (for example, a link to send someone else), add `&fresh`: https://draegs34.github.io/Guardians/?test&fresh. It forgets who you are and your alert settings in that browser, then drops `fresh` from the address. `?fresh` works on the real site too.
- To go back to the real site, open the link without `?test`.

## For developers
- **Cache busting:** `index.html` loads `style.css`, `config.js`, `engine.js`, `live.js` and `app.js` with a `?v=` tag. Bump that number whenever you change any of those files, or phones may keep running an old cached copy.
- **Draft rules:** these live in `engine.js`. The Firebase functions load it directly; it's copied into `functions/` when you deploy. (`apps-script/Code.gs` has an older copy from the Google Sheet days; it doesn't know about inactive postseason members.)
- **Choosing a draft:** the script's web app takes `?draft=rs` or `?draft=post` (the default), plus `?view=archives`. POST bodies carry `"draft"`.

The page footer shows when the site was last published (the time GitHub Pages put your latest push live).

*Private page for our season ticket group. Not affiliated with the Cleveland Guardians or MLB.*
