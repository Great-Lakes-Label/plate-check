# Plate Check — instructions for Claude Code

This is Great Lakes Label's press-side copy verification tool. A press operator photographs
the job ticket, the Art Proof Approval sheet, and one label off the press; the app confirms the
item number, compares the wording, compares the nutrition callouts by shape, and prints a signed
record. It is a static site on GitHub Pages, all processing in the browser, no backend.

Read `README.md` before changing anything. It records why each part is built the way it is,
and most of those reasons were learned by testing against real photos after simpler approaches
failed. Do not simplify something the README explains without re-testing it.

## Working rules

**Version every deploy.** `APP_VERSION` in `index.html` must be bumped on every change, and the
`?v=` on each `<script src>` must match it. Safari on the iPad caches each module file separately;
a stale `pipeline.js` under a fresh `index.html` has cost several rounds of confusion. The header
and self-check display the version so the operator can confirm what is running.

**Test against the real OCR library, not the command-line one.** Tesseract.js in Safari reads
differently from CLI Tesseract. Every threshold was finally tuned by running the actual
Tesseract.js package in Node (with `@napi-rs/canvas` for the DOM canvas) on real GLL photos.
Word data from Tesseract.js is nested under `data.blocks`; `pipeline.js` flattens it and falls
back to `data.tsv`.

**Never fuzzy-match item or job numbers.** Neighbouring items differ by one digit
(`10-9813960` vs `10-9813961`). An OCR misread is rejected, not nudged to a match. Exact match of
all nine digits at low confidence is accepted, because misreading *into* the exact typed number
is vanishingly unlikely.

**Numbers in copy must match exactly.** Alphabetic words tolerate glyph-confusion slips; anything
containing a digit does not. `170` vs `180` is the error this tool exists to catch.

**Nutrition callouts are compared by shape, not read.** Tesseract reads `5` as `9` in that
condensed face at 84% confidence — a wrong value, worse than no value. `bubbles.js` isolates each
callout's number line on both photos and compares the shapes. Do not replace this with OCR.

**Colour is not evaluated, on purpose.** The Art Proof Approval is not a colour standard; a
colour verdict drawn from it would mislead. GMI colour is a spectrophotometer job.

**Only report what was read on both sides, plus confident one-sided phrases.** Press photos read
worse than proofs, so a word missing from the press is usually a reading gap. The rules and
thresholds in `copycheck.js` encode this; read the comments before changing them.

**Keep the operator flow to three photos and one confirm.** Ticket → proof → press. Nothing is
boxed by hand; regions are located automatically. If a step cannot proceed, say why in the note
under that step and offer a retake — never guess.

## Files

- `index.html` — the page: flow, verdict, findings, print record, self-check, diagnostics
- `barcodes.js` — job ticket: locate barcode regions, decode with ZXing, classify Job # / Item #
- `pipeline.js` — photo handling: EXIF orientation, paper/artwork/label location, approval-block
  matching, multi-channel and per-band OCR, position-based token merge
- `copycheck.js` — word-level diff with OCR-error tolerance
- `bubbles.js` — nutrition callout shape comparison
- `sync.js` — optional SharePoint mirror (off by default; see `SHAREPOINT-SETUP.md`)
- `items.json` — optional item metadata (descriptor, customer) used on the printed record
- `ocr.js` — NOT referenced by `index.html`. Written by someone else; ask before deleting.

## Deploying

Commit to `main`; GitHub Pages redeploys in about a minute. After pushing, confirm the version in
the app header matches `APP_VERSION`. If it does not, the iPad is serving a cached copy.

## Do not

- Force-push, rewrite history, or delete `items.json` / `SHAREPOINT-SETUP.md`.
- Add a backend, API key, or any credential to this repo. It is public.
- Remove the diagnostics panel or the version stamp; they exist because remote debugging
  without them failed repeatedly.
