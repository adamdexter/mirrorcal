/**
 * MirrorCal configuration.
 *
 * 1. Make a copy of this file named `Config.gs` (File > New > Script file).
 * 2. Edit the values below.
 *
 * Finding a calendar ID: Google Calendar > hover the calendar in the left
 * sidebar > ⋮ > "Settings and sharing" > scroll to "Integrate calendar".
 * Your primary calendar's ID is simply your email address.
 */
var CONFIG = {
  // Calendars to mirror FROM. label (optional) prefixes copied titles, e.g.
  // "[Work] Standup". colorId (optional, '1'–'11') colors the copies.
  SOURCE_CALENDARS: [
    { id: 'you@gmail.com', label: '', colorId: null },
    // { id: 'abc123@group.calendar.google.com', label: 'Side project', colorId: '7' },
  ],

  // Calendar to mirror INTO (your "Calendar Audit" calendar). Create a fresh
  // calendar for this — MirrorCal manages its contents.
  TARGET_CALENDAR: 'xxxxxxxxxxxx@group.calendar.google.com',

  // Sync window (days). Past events matter for audits — keep some history.
  DAYS_PAST: 14,
  DAYS_FUTURE: 30,

  // Copy source event descriptions onto the clones? Off by default: invite
  // threads and meeting links often live there, and audits rarely need them.
  COPY_DESCRIPTION: false,

  // Skip events marked "Free" (transparent) — usually reminders/FYI holds.
  SKIP_FREE_EVENTS: true,

  // Skip events you've declined.
  SKIP_DECLINED: true,

  // Keep client edits to a clone's title and color across re-syncs, and always
  // preserve the Calendar Audit tag block in the description.
  PRESERVE_CLIENT_EDITS: true,

  // Append an empty Calendar Audit tag block to every clone so tagging can be done
  // right in Google Calendar by filling in the blanks.
  ADD_EMPTY_TAG_BLOCK: true,
};
