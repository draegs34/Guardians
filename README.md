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
- **Turn alerts**: each member chooses their name under **Turn alerts on this device for**. This is remembered per device and per draft. When it's their turn, a red banner appears, the On-the-clock card pulses and the browser tab title flashes. A blue banner shows when they're up next. There's no sound.
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
- **Cache busting:** `index.html` loads `style.css`, `config.js`, `engine.js` and `app.js` with a `?v=` tag. Bump that number whenever you change any of those files, or phones may keep running an old cached copy.
- **Draft rules:** these live in `engine.js`. `apps-script/Code.gs` ends with an exact copy of that block, so if you change one, copy it into the other.
- **Choosing a draft:** the script's web app takes `?draft=rs` or `?draft=post` (the default), plus `?view=archives`. POST bodies carry `"draft"`.

*Private page for our season ticket group. Not affiliated with the Cleveland Guardians or MLB.*
