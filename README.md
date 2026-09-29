# Guardians Postseason Ticket Draft

A live, pick-by-pick draft page for our season ticket group. Members take turns (snake order by default) claiming postseason home games and seat pairs. Every pick is saved to our Google Sheet.

- **The page** (`index.html`, `app.js`, `style.css`, `config.js`) is hosted free on GitHub Pages.
- **The data** lives in the Google Sheet. A small Apps Script (`apps-script/Code.gs`) reads and writes it.

Until `config.js` has a script URL, the page runs in **demo mode** with sample members, so you can try it out.

---

## One-time setup (about 10 minutes)

### 1. Add the script to the Google Sheet
1. Open the draft Google Sheet → **Extensions → Apps Script**.
2. Delete whatever is in `Code.gs`, then paste in the full contents of `apps-script/Code.gs` from this repo. Click **Save**.
3. In the toolbar's function dropdown, choose **setup** and click **Run**. Approve the permissions prompt: it's your own script, so click *Advanced → Go to project* if Google warns you.
4. Back in the sheet you'll see four new tabs. Your existing tabs aren't changed.
   - **Draft Members**: draft order and names.
   - **Draft Inventory**: every game and seat pair up for grabs, with prices. Add, remove or edit rows freely.
   - **Draft Settings**: title, snake draft on/off, optional max picks per member, open/paused, and the **Commissioner PIN** (only used for undo). Change `change-me`!
   - **Draft Picks**: filled in automatically. Only edit it to fix a mistake.

### 2. Deploy the script as a web app
1. In Apps Script, click **Deploy → New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**. Members don't need Google accounts or PINs.
4. Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

### 3. Point the page at the script
Open `config.js` and paste the URL:
```js
window.DRAFT_API_URL = "https://script.google.com/macros/s/XXXXXXXX/exec";
```
Commit and push.

### 4. Turn on GitHub Pages
On GitHub: repo **Settings → Pages** → Source **Deploy from a branch** → Branch **main**, folder **/(root)** → **Save**.
After a minute or two the site is live at **https://draegs34.github.io/Guardians/**.

---

## Running the draft
- Share the link. Whoever is **On the clock** taps an open seat pair and taps **Lock it in**. One pick per turn; in snake order the member at each end of the order picks twice in a row (end of one round, start of the next).
- There are no member PINs, so anyone with the link can make the on-clock person's pick. You can also make it for them when they text you.
- The board refreshes every 10 seconds for everyone.
- **Commissioner** (you): use **Commissioner tools → Undo last pick** with your PIN to fix mistakes. You can also edit the Draft Picks tab directly.
- **Badges:** use the Notes column in Draft Inventory. Separate multiple badges with `;`. Home Game 4 in the ALCS and World Series is marked as available only with home-field advantage, since the lower seed hosts only Games 3–5.
- To **pause** the draft, set *Draft open* to `FALSE` in Draft Settings.
- The **Members** panel shows how many picks each person has and what they owe.

## If you change the script later
Edit it in Apps Script, then go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

*Private page for our season ticket group. Not affiliated with the Cleveland Guardians or MLB.*
