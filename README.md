# MirrorCal

**A privacy-preserving, edit-safe Google Calendar mirror — free, cloud-only, no app to install or keep running.**

MirrorCal copies events from one or more of your calendars into a single mirror calendar **with all attendees stripped**. The copies are yours: retitle them, recolor them, add notes — nothing touches the original events or notifies your guests. MirrorCal keeps the copies in sync with the originals (time changes, cancellations, new events) **without ever overwriting your edits**.

It's essentially Notion Calendar's "blocking" / auto-block feature as a standalone open-source tool — except it runs entirely inside your own Google account with nothing installed, and it's documented to keep running with the lid closed.

Common uses:
- **Consolidation** — merge several calendars (work, personal, side project) into one shareable view.
- **Privacy blocking** — give a second account or a colleague a "busy" mirror of your real calendar without exposing invite details.
- **Annotation** — keep a parallel copy of your schedule you can mark up freely (time tracking, journaling, reviews). Apps can build on this: [Calendar Audit Pro](https://github.com/adamdexter/calendar-audit-pro) uses MirrorCal as its sync engine.

## Why not existing tools?

| | MirrorCal | [karbassi/sync-multiple-google-calendars](https://github.com/karbassi/sync-multiple-google-calendars) | Notion Calendar blocking | CalendarBridge / OneCal |
|---|---|---|---|---|
| Free | ✅ | ✅ | ✅ | ❌ |
| Runs fully in the cloud | ✅ Apps Script triggers | ✅ | ⚠️ undocumented | ✅ |
| Survives edits to copies | ✅ patches in place | ❌ deletes & recreates everything | ⚠️ | ⚠️ |
| Strips attendees | ✅ always | ✅ | ✅ | ✅ |
| Description privacy | ✅ off by default | ❌ copied verbatim | ⚠️ | ✅ |
| All-day / multi-day events | ✅ | ❌ ([#31](https://github.com/karbassi/sync-multiple-google-calendars/issues/31)) | ✅ | ✅ |
| Open source | ✅ MIT | ✅ MIT | ❌ | ❌ |

## How it works

MirrorCal is a [Google Apps Script](https://script.google.com) — a small program that runs inside **your own Google account**, in Google's cloud. Your computer doesn't need to be on. Nothing is shared with any third party; events never leave your account.

- **Incremental sync**: uses Calendar API sync tokens, so each run only processes what changed.
- **In-place updates**: each copy remembers its source event (`mc_src_key` in hidden event metadata) and is *patched*, never deleted and recreated.
- **Edit preservation**: MirrorCal remembers exactly what *it* last wrote on each copy (title, color, and a fingerprint of the description) and only ever overwrites its own writing. Anything you change is treated as yours and left alone.
- **Cancellation handling**: untouched copies of cancelled events are removed; copies you've edited are kept and prefixed `[CANCELLED]` — your notes on a meeting that got dropped are still your notes.
- **Near-real-time**: triggers fire whenever a source calendar changes, plus a nightly full reconcile.

## Setup (~5 minutes)

1. **Create the target calendar.** In [Google Calendar](https://calendar.google.com): ⚙ Settings → *Add calendar* → *Create new calendar* → name it whatever you like (e.g. "Mirror") → Create.
2. **Open Apps Script.** Go to [script.google.com](https://script.google.com) → *New project*. Name it "MirrorCal".
3. **Add the code.** Replace the contents of `Code.gs` with this repo's [`Code.gs`](Code.gs). Then *File → New → Script file*, name it `Config`, and paste in [`Config.example.gs`](Config.example.gs).
4. **Configure.** In `Config.gs`:
   - List your source calendar IDs (your primary calendar's ID is your email address; for others: Google Calendar → hover calendar → ⋮ → *Settings and sharing* → *Integrate calendar* → "Calendar ID").
   - Set `TARGET_CALENDAR` to the new calendar's ID (same place).
5. **Enable the Calendar service.** In the Apps Script editor's left sidebar: *Services* (+) → *Google Calendar API* → Add. (Keep the identifier `Calendar`.)
6. **First run.** Select `sync` in the function dropdown → *Run* → approve the permissions prompt (Google will warn the app is unverified — it's your own script; click *Advanced → Go to MirrorCal*). Your mirror calendar fills with stripped copies.
7. **Automate.** Select `setupTriggers` → *Run*. This installs an instant trigger per source calendar plus a nightly reconcile. Done — close the tab forever.

**Tip:** turn off notifications on the mirror calendar (Settings and sharing → *Event notifications*: remove all), or every synced event may ping you.

**Workspace note:** because the copied script is owned by *you* inside your own domain, it counts as an internal app — it usually authorizes fine even in organizations that block third-party calendar tools (as long as your admin hasn't disabled Apps Script or unchecked "trust internal apps").

## Usage notes

- Your edits to copies are safe: rename them, recolor them, write anything in the description — re-syncs preserve all of it while still updating times and locations from the source.
- `CLONE_DESCRIPTION_TEMPLATE` seeds every new copy's description with text of your choice (a notes scaffold, a checklist, an app's structured block).
- To add another source calendar later: edit `Config.gs`, then run `setupTriggers` again.
- To start over: run `removeTriggers`, delete the copies (or the whole mirror calendar), run `resetSyncState`.
- **Don't** list the target calendar as a source — MirrorCal refuses it to avoid loops, but don't tempt fate.
- MirrorCal's bookkeeping lives in hidden event metadata under the `mc_` prefix; it never touches other apps' keys.

## Quotas

Google's free Apps Script quotas allow ~5,000 calendar events created per day and 90 min/day of trigger runtime — far beyond what personal calendar churn produces. If you hit rate limits, MirrorCal backs off and retries automatically.

## License

MIT
