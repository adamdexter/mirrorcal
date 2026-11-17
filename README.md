# MirrorCal

**A privacy-preserving, annotation-safe Google Calendar mirror — free, cloud-only, no app to install or keep running.**

MirrorCal copies events from one or more of your calendars into a single "Calendar Audit" calendar **with all attendees stripped**. The copies are yours: retitle them, recolor them, add notes — nothing touches the original events or notifies your guests. MirrorCal keeps the copies in sync with the originals (time changes, cancellations, new events) **without overwriting your annotations**.

Built for calendar-audit workflows (energy audits, [Zone of Genius](https://en.wikipedia.org/wiki/Gay_Hendricks) reviews, time tracking), and the open-source sync engine behind **Calendar Audit Pro**. Works standalone for anyone who wants a consolidated, editable mirror of their calendars.

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
- **In-place updates**: each copy remembers its source event (`ca_src_key` in hidden event metadata) and is *patched*, never deleted and recreated.
- **Annotation preservation**: your title/color edits to copies are kept (MirrorCal remembers what *it* last wrote and only overwrites its own values), and the Calendar Audit tag block in the description is always carried forward.
- **Cancellation handling**: untagged copies of cancelled events are removed; tagged ones are kept and prefixed `[CANCELLED]` — a record of a meeting you dropped is itself audit data.
- **Near-real-time**: triggers fire whenever a source calendar changes, plus a nightly full reconcile.

## Setup (~5 minutes)

1. **Create the target calendar.** In [Google Calendar](https://calendar.google.com): ⚙ Settings → *Add calendar* → *Create new calendar* → name it **Calendar Audit** → Create.
2. **Open Apps Script.** Go to [script.google.com](https://script.google.com) → *New project*. Name it "MirrorCal".
3. **Add the code.** Replace the contents of `Code.gs` with this repo's [`Code.gs`](Code.gs). Then *File → New → Script file*, name it `Config`, and paste in [`Config.example.gs`](Config.example.gs).
4. **Configure.** In `Config.gs`:
   - List your source calendar IDs (your primary calendar's ID is your email address; for others: Google Calendar → hover calendar → ⋮ → *Settings and sharing* → *Integrate calendar* → "Calendar ID").
   - Set `TARGET_CALENDAR` to the Calendar Audit calendar's ID (same place).
5. **Enable the Calendar service.** In the Apps Script editor's left sidebar: *Services* (+) → *Google Calendar API* → Add. (Keep the identifier `Calendar`.)
6. **First run.** Select `sync` in the function dropdown → *Run* → approve the permissions prompt (Google will warn the app is unverified — it's your own script; click *Advanced → Go to MirrorCal*). Your Calendar Audit calendar fills with stripped copies.
7. **Automate.** Select `setupTriggers` → *Run*. This installs an instant trigger per source calendar plus a nightly reconcile. Done — close the tab forever.

**Tip:** turn off notifications on the Calendar Audit calendar (Settings and sharing → *Event notifications*: remove all), or every synced event may ping you.

## Usage notes

- To tag events for an audit, fill in the block MirrorCal adds to each copy's description:
  ```
  ─────── Calendar Audit ───────
  Energy: +        (+ / -)
  Zone:   G        (I / C / E / G)
  Action: Own      (Drop / Delegate / Develop / Design / Own)
  Note:   worth protecting this time
  ──────────────────────────────
  ```
  Shorthand works too (`E:+`, `Z:G`, `A:drop`, full words like `Zone: Genius`). Tags are mirrored into hidden event metadata (`extendedProperties`) that apps like Calendar Audit Pro can query.
- To add another source calendar later: edit `Config.gs`, then run `setupTriggers` again.
- To start over: run `removeTriggers`, delete the copies (or the whole Calendar Audit calendar), run `resetSyncState`.
- **Don't** list the target calendar as a source — MirrorCal refuses it to avoid loops, but don't tempt fate.

## Quotas

Google's free Apps Script quotas allow ~5,000 calendar events created per day and 90 min/day of trigger runtime — far beyond what personal calendar churn produces. If you hit rate limits, MirrorCal backs off and retries automatically.

## License

MIT
