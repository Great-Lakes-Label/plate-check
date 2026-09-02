# Plate Check — Great Lakes Label

A single-page tool for press operators. The operator enters the job number, photographs a label
off the press, and the tool reads the artwork code from the photo and compares it to the code
expected for that job. Its purpose is to catch plates that were not changed between lots.

Runs entirely in the browser. No server, no build step, no install.

---

## Deploy to GitHub Pages

1. Create a repository (public or private — Pages works with private repos on paid plans).
2. Commit these three files to the repository root:
   - `index.html`
   - `copycheck.js`
   - `sync.js`
   - `items.json`
   - `README.md`
3. In the repo: **Settings → Pages**. Under *Build and deployment*, set **Source** to
   *Deploy from a branch*, branch `main`, folder `/ (root)`. Save.
4. Wait about a minute. The site appears at
   `https://<org-or-user>.github.io/<repo>/`
5. Open that URL on the shop tablet and add it to the home screen.

Do not open `index.html` by double-clicking it from a folder. Browsers block `fetch` on the
`file://` protocol, so the job table will not load. It needs to be served over `http://` or
`https://` — GitHub Pages, or `python3 -m http.server` for local testing.

---

## Maintaining the item table

`items.json` is a plain list. One entry per item number:

```json
{
  "item": "10-9813961",
  "code": "110068",
  "descriptor": "Lightly Salted",
  "customer": "Meijer — Whole-Roasted Cashews 26 oz"
}
```

| Field | Required | Notes |
|---|---|---|
| `item` | yes | The Item # from the Art Proof Approval. Matched on digits only, so `10-9813961`, `109813961`, and `10 9813961` all find the same record. |
| `code` | yes | The artwork code printed on the label. This is what gets compared. |
| `descriptor` | no | Large-type flavor or variant text. Used only to veto a false match (see below). |
| `customer` | no | Shown on screen so the operator can sanity-check the lookup. |

The operator also enters a Job #, which is recorded on every check but is not used for lookup.

Two entries are included as a worked example — the Meijer cashew pair, where `109709` is
*Salted* and `110068` is *Lightly Salted*.

**Keeping it current.** Editing this file by hand does not scale past a few dozen jobs. The
practical version is a scheduled export from Radius that writes `items.json` and commits it,
or a GitHub Action that pulls from a CSV. Until that exists, the tool still works without the
table: type the expected artwork code directly into the job box and any 4-or-more-digit entry
not found in the table is treated as the target code.

---

## How the verdict is decided

Three outcomes. The tool never prints a pass it cannot support.

**MATCH** — the expected code was found on the label.

**STOP — codes differ** — a different code of the same length was found. This is the plate error
the tool exists to catch.

**NO READ** — no code-shaped digits were found. Not a pass and not a fail. The operator retakes
the photo or drags a box around the code to re-read just that area.

There is a fourth path worth knowing about. `descriptor` guards a specific trap: if a job's
descriptor is *Salted* and the label reads *Lightly Salted*, a naive text match would pass,
because "Salted" is contained inside "Lightly Salted". When the expected code is found but a
longer, related descriptor belonging to a different job also appears on the label, the tool
returns **STOP — copy conflict** instead of a match. This only works for descriptors that are
present in `items.json`, which is a reason to keep variant families complete in the table.

---

## Limits worth knowing before this goes on the floor

**It only catches errors the artwork code reveals.** Two SKUs that share an artwork code but
differ some other way will pass. Worth confirming against the item master that codes are unique
per SKU across the customers you run.

**It reads after material is printed.** Scanning barcoded plates at mounting time catches the
same mistake before the press runs and wastes nothing. This tool is a backstop, not a substitute
for that control.

**OCR is not perfect.** Glare, curl, and low light all hurt it. The NO READ state exists so a bad
photo does not become a false pass, but a shop-floor fixture — fixed camera distance, even
lighting, label held flat under glass — will do more for reliability than any change to this code.

**Records are printed, not stored.** There is no log and no CSV export. After a check, the
operator taps Print result and a one-page record comes out with the job, item, verdict, the copy
differences, reader coverage, and signature lines for the operator and supervisor. Staple it to
the job jacket. A signed sheet in the jacket is a stronger audit artefact than browser storage
that dies with the device.

If a digital record is wanted alongside the paper one, `sync.js` still mirrors each check to a
SharePoint list independently — see SHAREPOINT-SETUP.md. It is off by default.

**Printing needs AirPrint.** Safari on iPad can only print to AirPrint-capable printers on the
same network. If the shop printer is not AirPrint, the iPad cannot reach it directly; options are
a print server, an AirPrint bridge, or printing from a PC on the same page.

**First load needs internet.** The text-recognition engine and its English language data come
from a CDN on first use, a few megabytes. The browser caches them afterward, but a device that
has never opened the page will not work offline.
