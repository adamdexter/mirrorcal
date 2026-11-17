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

  // Calendar to mirror INTO. Create a fresh calendar for this — MirrorCal
  // manages its contents.
  TARGET_CALENDAR: 'xxxxxxxxxxxx@group.calendar.google.com',

  // Sync window (days).
  DAYS_PAST: 14,
  DAYS_FUTURE: 30,

  // Copy source event descriptions onto the clones? Off by default: invite
  // threads and meeting links often live there, and a mirror calendar you
  // share or annotate rarely needs them.
  COPY_DESCRIPTION: false,

  // Skip events marked "Free" (transparent) — usually reminders/FYI holds.
  SKIP_FREE_EVENTS: true,

  // Skip events you've declined.
  SKIP_DECLINED: true,

  // Keep your edits to a clone (title, color, description) across re-syncs.
  // MirrorCal remembers what it last wrote and only overwrites its own writing.
  PRESERVE_CLIENT_EDITS: true,

  // Skip events titled exactly "Busy" — the placeholder name used by
  // availability blockers (Notion Calendar, Outlook). Prevents double-mirroring
  // when a source already contains another tool's blocker copies.
  SKIP_BUSY_PLACEHOLDERS: false,

  // Optional: text appended to every new clone's description — a notes
  // scaffold, a checklist, anything. Apps built on MirrorCal use this too
  // (e.g. Calendar Audit Pro seeds its tag block here). '' to disable.
  CLONE_DESCRIPTION_TEMPLATE: '',
};
