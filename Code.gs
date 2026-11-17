/**
 * MirrorCal — annotation-preserving Google Calendar mirror.
 *
 * Mirrors events from one or more source calendars into a single target
 * ("Calendar Audit") calendar with attendees stripped, so the owner can
 * freely retitle, recolor, and annotate the copies without affecting the
 * original events or their guests.
 *
 * Unlike naive merge scripts, MirrorCal patches clones in place using
 * incremental sync tokens, so annotations (the Calendar Audit tag block in the
 * description, color changes, renamed titles) survive re-syncs.
 *
 * Entry points:
 *   setupTriggers()  — one-time: installs per-calendar update triggers + nightly reconcile
 *   sync()           — incremental sync of all sources (what the triggers call)
 *   fullReconcile()  — full-window resync + prune of orphaned clones (nightly)
 *   removeTriggers() — removes all MirrorCal triggers
 *   resetSyncState() — clears stored sync tokens (next run is a full sync)
 *
 * Requires the "Calendar" Advanced Service (see appsscript.json / README).
 * Configuration lives in Config.gs — copy Config.example.gs to get started.
 */

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function sync() {
  withScriptLock_(function () {
    getSources_().forEach(function (src) {
      syncSource_(src, /* forceFull */ false, /* seenKeys */ null);
    });
  });
}

function fullReconcile() {
  withScriptLock_(function () {
    var seenKeys = {};
    getSources_().forEach(function (src) {
      syncSource_(src, /* forceFull */ true, seenKeys);
    });
    pruneOrphanClones_(seenKeys);
  });
}

function setupTriggers() {
  removeTriggers();
  getSources_().forEach(function (src) {
    ScriptApp.newTrigger('sync').forUserCalendar(src.id).onEventUpdated().create();
  });
  ScriptApp.newTrigger('fullReconcile').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Installed %s calendar triggers + nightly reconcile.', getSources_().length);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sync' || fn === 'fullReconcile') ScriptApp.deleteTrigger(t);
  });
}

function resetSyncState() {
  var props = PropertiesService.getUserProperties();
  getSources_().forEach(function (src) {
    props.deleteProperty(syncTokenKey_(src.id));
  });
  Logger.log('Sync tokens cleared. Next sync() will be a full window sync.');
}

// ---------------------------------------------------------------------------
// Core sync
// ---------------------------------------------------------------------------

function getSources_() {
  if (typeof CONFIG === 'undefined') {
    throw new Error('CONFIG not found. Copy Config.example.gs to a Config.gs file and edit it.');
  }
  return CONFIG.SOURCE_CALENDARS.filter(function (src) {
    if (src.id === CONFIG.TARGET_CALENDAR) {
      Logger.log('WARNING: target calendar listed as a source; skipping it to avoid a sync loop.');
      return false;
    }
    return true;
  });
}

function syncTokenKey_(calendarId) {
  return 'mirrorcal::token::' + calendarId;
}

/**
 * Sync one source calendar. Uses a stored sync token when available
 * (incremental); otherwise performs a full sync over the configured window.
 * When seenKeys is provided (reconcile mode), records every live source key.
 */
function syncSource_(src, forceFull, seenKeys) {
  var props = PropertiesService.getUserProperties();
  var tokenKey = syncTokenKey_(src.id);
  if (forceFull) props.deleteProperty(tokenKey);
  var syncToken = props.getProperty(tokenKey);

  var pageToken = null;
  var newSyncToken = null;
  var events = [];

  try {
    do {
      var params = { singleEvents: true, maxResults: 250, showDeleted: true };
      if (pageToken) params.pageToken = pageToken;
      if (syncToken && !pageToken) params.syncToken = syncToken;
      if (syncToken) {
        // nothing else allowed alongside a sync token
      } else {
        params.timeMin = isoOffsetDays_(-CONFIG.DAYS_PAST);
        params.timeMax = isoOffsetDays_(CONFIG.DAYS_FUTURE);
      }
      var resp = withBackoff_(function () {
        return Calendar.Events.list(src.id, params);
      });
      events = events.concat(resp.items || []);
      pageToken = resp.nextPageToken || null;
      if (!pageToken) newSyncToken = resp.nextSyncToken || null;
    } while (pageToken);
  } catch (err) {
    if (isGoneError_(err)) {
      // Sync token expired — fall back to a full window sync.
      props.deleteProperty(tokenKey);
      return syncSource_(src, true, seenKeys);
    }
    throw err;
  }

  events.forEach(function (ev) {
    try {
      processEvent_(src, ev, seenKeys);
    } catch (e) {
      Logger.log('Error processing event %s from %s: %s', ev.id, src.id, e);
    }
  });

  if (newSyncToken) props.setProperty(tokenKey, newSyncToken);
  Logger.log('Synced %s event change(s) from %s%s.', events.length, src.id, syncToken ? ' (incremental)' : ' (full)');
}

function processEvent_(src, ev, seenKeys) {
  // Never clone a clone (covers misconfiguration where a target feeds a source).
  var evProps = (ev.extendedProperties && ev.extendedProperties.private) || {};
  if (evProps.ca_src_key) return;

  var key = srcKey_(src.id, ev.id);

  if (ev.status === 'cancelled') {
    handleCancelled_(key);
    return;
  }
  if (CONFIG.SKIP_FREE_EVENTS && ev.transparency === 'transparent') return;
  if (CONFIG.SKIP_DECLINED && isDeclinedBySelf_(ev)) return;

  if (seenKeys) seenKeys[key] = true;

  var existing = findCloneByKey_(key);
  var resource = buildCloneResource_(src, ev, existing);

  if (existing) {
    withBackoff_(function () {
      return Calendar.Events.patch(resource, CONFIG.TARGET_CALENDAR, existing.id);
    });
  } else {
    withBackoff_(function () {
      return Calendar.Events.insert(resource, CONFIG.TARGET_CALENDAR);
    });
  }
}

function srcKey_(calendarId, eventId) {
  return calendarId + '::' + eventId;
}

function findCloneByKey_(key) {
  var resp = withBackoff_(function () {
    return Calendar.Events.list(CONFIG.TARGET_CALENDAR, {
      privateExtendedProperty: 'ca_src_key=' + key,
      maxResults: 2,
      showDeleted: false,
    });
  });
  var items = resp.items || [];
  return items.length ? items[0] : null;
}

/**
 * Build the clone event resource. Mirrored fields (time, title, location)
 * come from the source; annotation fields (tag block, client color/title
 * edits) are preserved from the existing clone.
 */
function buildCloneResource_(src, ev, existing) {
  var mirrorTitle = (src.label ? '[' + src.label + '] ' : '') + (ev.summary || 'Busy');
  var existingProps = (existing && existing.extendedProperties && existing.extendedProperties.private) || {};

  // Title: keep a client's rename if PRESERVE_CLIENT_EDITS and they changed it
  // since we last mirrored (we remember what we last wrote in ca_mirror_title).
  var title = mirrorTitle;
  if (existing && CONFIG.PRESERVE_CLIENT_EDITS) {
    var lastMirrored = existingProps.ca_mirror_title;
    var current = stripCancelledPrefix_(existing.summary || '');
    if (lastMirrored && current !== lastMirrored) title = existing.summary;
  }

  // Color: same preservation logic via ca_mirror_color.
  var mirrorColor = src.colorId || null;
  var colorId = mirrorColor;
  if (existing && CONFIG.PRESERVE_CLIENT_EDITS) {
    var lastColor = existingProps.ca_mirror_color || '';
    var currentColor = existing.colorId || '';
    if (currentColor !== lastColor) colorId = existing.colorId || null;
  }

  // Description: mirrored source text (optional) + preserved/created tag block.
  var existingBlock = existing ? extractTagBlock_(existing.description || '') : null;
  var block = existingBlock !== null ? existingBlock : (CONFIG.ADD_EMPTY_TAG_BLOCK ? emptyTagBlock_() : '');
  var mirroredDesc = CONFIG.COPY_DESCRIPTION ? (ev.description || '') : '';
  var description = joinNonEmpty_([mirroredDesc, block], '\n\n');

  // Mirror tags parsed from the block into extended properties so any API
  // consumer (Calendar Audit Pro) can query them. The description block is authoritative.
  var tags = parseTagBlock_(block);

  var privateProps = {
    ca_src_key: srcKey_(src.id, ev.id),
    ca_src_cal: src.id,
    ca_src_event_id: ev.id,
    ca_synced_at: new Date().toISOString(),
    ca_mirror_title: mirrorTitle,
    ca_mirror_color: mirrorColor || '',
    ca_energy: tags.energy || '',
    ca_zone: tags.zone || '',
    ca_action: tags.action || '',
  };

  var resource = {
    summary: title,
    location: ev.location || '',
    description: description,
    start: ev.start,
    end: ev.end,
    transparency: ev.transparency,
    extendedProperties: { private: privateProps },
    reminders: { useDefault: false, overrides: [] },
  };
  if (colorId) resource.colorId = colorId;
  return resource;
}

function handleCancelled_(key) {
  var clone = findCloneByKey_(key);
  if (!clone) return;
  var cloneProps = (clone.extendedProperties && clone.extendedProperties.private) || {};
  var hasTags = !!(cloneProps.ca_energy || cloneProps.ca_zone || cloneProps.ca_action) ||
    tagBlockHasValues_(extractTagBlock_(clone.description || ''));

  if (hasTags) {
    // Tagged clones are audit records — keep them, mark as cancelled.
    if ((clone.summary || '').indexOf('[CANCELLED]') !== 0) {
      withBackoff_(function () {
        return Calendar.Events.patch(
          {
            summary: '[CANCELLED] ' + (clone.summary || ''),
            extendedProperties: { private: { ca_cancelled: 'true' } },
          },
          CONFIG.TARGET_CALENDAR,
          clone.id
        );
      });
    }
  } else {
    withBackoff_(function () {
      return Calendar.Events.remove(CONFIG.TARGET_CALENDAR, clone.id);
    });
  }
}

/**
 * After a full reconcile, remove (or mark) clones in the window whose source
 * event no longer exists. Only touches events that carry our ca_src_key and
 * whose source calendar is still configured.
 */
function pruneOrphanClones_(seenKeys) {
  var sourceIds = {};
  getSources_().forEach(function (s) { sourceIds[s.id] = true; });

  var pageToken = null;
  do {
    var params = {
      timeMin: isoOffsetDays_(-CONFIG.DAYS_PAST),
      timeMax: isoOffsetDays_(CONFIG.DAYS_FUTURE),
      singleEvents: true,
      maxResults: 250,
    };
    if (pageToken) params.pageToken = pageToken;
    var resp = withBackoff_(function () {
      return Calendar.Events.list(CONFIG.TARGET_CALENDAR, params);
    });
    (resp.items || []).forEach(function (clone) {
      var p = (clone.extendedProperties && clone.extendedProperties.private) || {};
      if (!p.ca_src_key) return;           // not ours — never touch
      if (!sourceIds[p.ca_src_cal]) return; // source no longer configured — leave alone
      if (p.ca_cancelled === 'true') return;
      if (!seenKeys[p.ca_src_key]) handleCancelled_(p.ca_src_key);
    });
    pageToken = resp.nextPageToken || null;
  } while (pageToken);
}

// ---------------------------------------------------------------------------
// Calendar Audit tag block (kept in lockstep with the @mirrorcal/core codec)
// ---------------------------------------------------------------------------

var TAG_BLOCK_START = '─────── Calendar Audit ───────';
var TAG_BLOCK_END = '──────────────────────────────';

function emptyTagBlock_() {
  return [
    TAG_BLOCK_START,
    'Energy:        (+ / -)',
    'Zone:          (I / C / E / G)',
    'Action:        (Drop / Delegate / Develop / Design / Own)',
    'Note:  ',
    TAG_BLOCK_END,
  ].join('\n');
}

/** Returns the tag block substring from a description, or null if absent. */
function extractTagBlock_(description) {
  var text = htmlToText_(description || '');
  // Dashes on both sides of the name, so prose mentioning "calendar audit"
  // never reads as a block. Kept in lockstep with the TypeScript codec.
  var m = text.match(/─{2,}[^\n─]*calendar audit[^\n─]*─{2,}/i);
  if (!m) return null;
  var startIdx = m.index;
  // Walk back to the start of the fence line, forward to the closing fence.
  var lineStart = text.lastIndexOf('\n', startIdx) + 1;
  var endFence = text.indexOf(TAG_BLOCK_END, startIdx);
  if (endFence === -1) {
    // Tolerate a missing/edited closing fence: take to end of text.
    return text.slice(lineStart);
  }
  return text.slice(lineStart, endFence + TAG_BLOCK_END.length);
}

function tagBlockHasValues_(block) {
  if (!block) return false;
  var t = parseTagBlock_(block);
  return !!(t.energy || t.zone || t.action || t.note);
}

/** Forgiving parser: case-insensitive, shorthand keys, word values. */
function parseTagBlock_(block) {
  var tags = {};
  if (!block) return tags;
  htmlToText_(block).split('\n').forEach(function (line) {
    var m = line.match(/^\s*(energy|e|zone|z|action|a|note|n)\s*[:=]\s*(.*)$/i);
    if (!m) return;
    var keyRaw = m[1].toLowerCase();
    var value = m[2].replace(/\(.*?\)/g, '').trim(); // drop "(+ / -)" hints
    if (!value) return;
    if (keyRaw === 'energy' || keyRaw === 'e') {
      var v = value.charAt(0);
      if (v === '+' || /^(plus|pos)/i.test(value)) tags.energy = '+';
      else if (v === '-' || v === '–' || /^(minus|neg)/i.test(value)) tags.energy = '-';
    } else if (keyRaw === 'zone' || keyRaw === 'z') {
      var z = value.charAt(0).toUpperCase();
      if ('ICEG'.indexOf(z) !== -1) tags.zone = z;
      else if (/^gen/i.test(value)) tags.zone = 'G';
      else if (/^exc/i.test(value)) tags.zone = 'E';
      else if (/^inc/i.test(value)) tags.zone = 'I';
      else if (/^com/i.test(value)) tags.zone = 'C';
    } else if (keyRaw === 'action' || keyRaw === 'a') {
      var a = value.toLowerCase();
      if (/^drop/.test(a)) tags.action = 'Drop';
      else if (/^deleg/.test(a)) tags.action = 'Delegate';
      else if (/^devel/.test(a)) tags.action = 'Develop';
      else if (/^design/.test(a)) tags.action = 'Design';
      else if (/^own/.test(a)) tags.action = 'Own';
    } else if (keyRaw === 'note' || keyRaw === 'n') {
      tags.note = m[2].trim();
    }
  });
  return tags;
}

/** Google Calendar descriptions can arrive as HTML; normalize to plain text. */
function htmlToText_(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isoOffsetDays_(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function joinNonEmpty_(parts, sep) {
  return parts.filter(function (p) { return p && p.trim(); }).join(sep);
}

function stripCancelledPrefix_(title) {
  return title.replace(/^\[CANCELLED\]\s*/, '');
}

function isDeclinedBySelf_(ev) {
  var attendees = ev.attendees || [];
  for (var i = 0; i < attendees.length; i++) {
    if (attendees[i].self && attendees[i].responseStatus === 'declined') return true;
  }
  return false;
}

function isGoneError_(err) {
  var msg = String(err && err.message || err);
  return msg.indexOf('410') !== -1 || /sync token is no longer valid/i.test(msg) || /fullSyncRequired/i.test(msg);
}

/** Retry with exponential backoff on rate-limit / transient errors. */
function withBackoff_(fn) {
  var delays = [0, 1000, 2000, 4000, 8000];
  var lastErr;
  for (var i = 0; i < delays.length; i++) {
    if (delays[i]) Utilities.sleep(delays[i]);
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      var msg = String(err && err.message || err);
      var transient = /(rate limit|quota|429|500|502|503|backend error|internal error)/i.test(msg);
      if (!transient) throw err;
    }
  }
  throw lastErr;
}

/** Prevent overlapping trigger runs from double-writing. */
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Another sync is running; skipping this invocation.');
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}
