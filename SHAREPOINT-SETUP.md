# SharePoint logging setup

Local storage stays the source of truth. Every completed check is written to the tablet first,
then queued for SharePoint. If the network is down the queue holds and drains later, so a
dropped connection never costs you a record and never makes an operator wait.

Pick one route below and set `MODE` at the top of `sync.js`.

---

## 1. Create the list

SharePoint site → **New → List** → name it `Plate Check Log`. Add these columns.
Names must match exactly; Graph and Power Automate both address them by internal name.

| Column | Type | Notes |
|---|---|---|
| `Title` | Single line of text | Built in. Holds the Job #. |
| `ItemNumber` | Single line of text | The Item # from the Art Proof Approval. |
| `CheckedAt` | Date and time | Include time. Set to UTC or accept the ISO string as-is. |
| `Customer` | Single line of text | |
| `ExpectedCode` | Single line of text | Text, not number — leading zeros matter. |
| `CodeRead` | Single line of text | May hold several candidates separated by spaces. |
| `Result` | Choice | `Match`, `Stop`, `No read` |
| `Operator` | Single line of text | Populated only on the Graph route. |
| `Station` | Single line of text | Press or tablet, set once per device. |

If you rename a column after creating it, SharePoint keeps the original internal name. Check
**List settings → Columns** and use the internal name in `sync.js`, not the display name.

---

## 2. Route A — Power Automate HTTP trigger

Quickest to stand up, roughly twenty minutes.

1. Power Automate → **Create → Instant cloud flow → When an HTTP request is received**.
2. Leave the request body schema empty. Save once to generate the URL, then copy it.
3. Add **SharePoint → Create item**. Point it at the site and list.
4. Map each field using an expression against the parsed body, for example:
   `json(triggerBody())?['Title']`, `json(triggerBody())?['ExpectedCode']`, and so on.
   The `json()` wrapper is required because the tool posts as `text/plain` — see below.
5. Save, then paste the URL into `FLOW_URL` in `sync.js` and set `MODE: "flow"`.

**Why text/plain.** A JSON content-type makes the browser send a CORS preflight, and Power
Automate's HTTP trigger does not answer preflights — the request dies before it leaves the
browser. Posting as `text/plain` qualifies as a simple request and goes through. The response
still isn't readable cross-origin, so the tool treats a completed request as *sent* rather than
*written*. The list is your confirmation.

**Three things to know before choosing this route.**

The trigger URL contains its own access signature. Anyone who can read `sync.js` can write rows
to your list — and on GitHub Pages, that is the public internet. The payload is harmless
(job numbers and artwork codes), but the list can be filled with junk. You can add a shared
secret to the payload and a condition in the flow that drops anything without it, which raises
the bar without eliminating the problem.

The HTTP request trigger is a premium connector. It needs Power Automate Premium licensing on
the flow owner's account. Worth confirming with whoever manages your M365 licensing before you
build on it.

There is no operator identity. Rows arrive anonymously with only the station tag, so the record
shows which press ran the check but not who ran it.

---

## 3. Route B — Entra app registration + Microsoft Graph

More setup, better result. This is the one I'd build if the log needs to hold up in an audit.

1. Entra admin center → **App registrations → New registration**.
   - Name: `GLL Plate Check`
   - Supported account types: this organization only
   - Redirect URI: platform **Single-page application**, URI = your exact Pages URL
     (for example `https://greatlakeslabel.github.io/plate-check/`)
2. **API permissions → Add → Microsoft Graph → Delegated → `Sites.ReadWrite.All`**,
   then **Grant admin consent**. (`Sites.Selected` with an explicit grant on just the
   Operations site is tighter, if your admin is willing to configure it.)
3. Copy the Application (client) ID and Directory (tenant) ID into `CONFIG.GRAPH` in `sync.js`.
   Set `sitePath` to the server-relative path of the site, e.g. `/sites/Operations`.
4. Uncomment the MSAL script tag in `index.html`.
5. Set `MODE: "graph"`.

The operator signs in once with their GLL account. The token is cached in local storage and
survives tablet restarts, so in practice sign-in happens on first use and after password
changes or policy expiry — not every shift.

**What this buys you.** No secret in the page source. Writes are attributed to a real account,
so the list records who performed each check. Permissions are revocable per user through normal
M365 offboarding. No premium license.

**What it costs.** An admin has to register the app and grant consent, and a shared tablet
means every operator either signs in under one shared service account — which throws away the
identity benefit — or signs in individually, which adds friction. Decide which before rollout.

---

## 4. Worth asking before you build either one

If the log lives in SharePoint and operators authenticate against M365 anyway, GitHub Pages
stops earning its place. Two alternatives:

**Azure Static Web Apps** has built-in Entra authentication and same-origin API routes, which
removes the CORS problem and the embedded-secret problem at once. Free tier covers this
comfortably. It is the natural home for this tool once logging matters.

**A Power App** replaces the whole thing. Camera control, direct SharePoint connection, identity
and offline queueing handled for you. You lose the browser OCR — you would call Azure AI Vision
or an AI Builder model instead — and you gain a supported platform that someone other than you
can maintain. If this tool becomes something GLL depends on daily, that maintainability question
matters more than the code.

I would keep the static site while you prove the concept on the floor, then move it once
operators confirm the OCR is reliable enough on real labels to be worth institutionalizing.
