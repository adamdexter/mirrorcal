/**
 * MirrorCal — a privacy-preserving, edit-safe Google Calendar mirror.
 *
 * Mirrors events from one or more source calendars into a single target
 * calendar with all attendees stripped, so the owner can freely retitle,
 * recolor, and annotate the copies without affecting the original events or
 * notifying their guests. (Think Notion Calendar's "blocking"/auto-block
 * feature — open source, running entirely in your own Google account.)
 *
 * Unlike naive merge scripts, MirrorCal patches clones in place using
 * incremental sync tokens, and it treats anything you change on a clone
 * (title, color, description) as yours: it remembers what it last wrote and
 * only ever overwrites its own writing.
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
      if (!syncToken) {
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
  if (evProps.mc_src_key) return;

  var key = srcKey_(src.id, ev.id);

  if (ev.status === 'cancelled') {
    handleCancelled_(key);
    return;
  }
  if (CONFIG.SKIP_FREE_EVENTS && !src.includeFree && ev.transparency === 'transparent') return;
  if (CONFIG.SKIP_DECLINED && isDeclinedBySelf_(ev)) return;
  if (CONFIG.SKIP_BUSY_PLACEHOLDERS && String(ev.summary || '').trim().toLowerCase() === 'busy') return;

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
      privateExtendedProperty: 'mc_src_key=' + key,
      maxResults: 2,
      showDeleted: false,
    });
  });
  var items = resp.items || [];
  return items.length ? items[0] : null;
}

/**
 * Build the clone event resource. Mirrored fields (time, title, location)
 * come from the source; the owner's edits to the clone (title, color,
 * description) are preserved — MirrorCal only overwrites its own writing,
 * which it remembers in mc_* extended properties.
 */
function buildCloneResource_(src, ev, existing) {
  var mirrorTitle = (src.label ? '[' + src.label + '] ' : '') + (ev.summary || 'Busy');
  var existingProps = (existing && existing.extendedProperties && existing.extendedProperties.private) || {};

  // Title: keep the owner's rename if they changed it since we last mirrored.
  var title = mirrorTitle;
  if (existing && CONFIG.PRESERVE_CLIENT_EDITS) {
    var lastMirrored = existingProps.mc_mirror_title;
    var current = stripCancelledPrefix_(existing.summary || '');
    if (lastMirrored && current !== lastMirrored) title = existing.summary;
  }

  // Color: same preservation rule via mc_mirror_color.
  var mirrorColor = src.colorId || null;
  var colorId = mirrorColor;
  if (existing && CONFIG.PRESERVE_CLIENT_EDITS) {
    var lastColor = existingProps.mc_mirror_color || '';
    var currentColor = existing.colorId || '';
    if (currentColor !== lastColor) colorId = existing.colorId || null;
  }

  // Description: MirrorCal's version is the mirrored source text (optional)
  // plus the configured template. Once the owner edits the description
  // (detected by hash of what we last authored), their version is kept.
  var mirroredDesc = CONFIG.COPY_DESCRIPTION ? (ev.description || '') : '';
  var authored = joinNonEmpty_([mirroredDesc, CONFIG.CLONE_DESCRIPTION_TEMPLATE || ''], '\n\n');
  var description = authored;
  var descHash = hashText_(authored);
  if (existing && CONFIG.PRESERVE_CLIENT_EDITS && existingProps.mc_mirror_desc_hash !== undefined && existingProps.mc_mirror_desc_hash !== null) {
    var currentHash = hashText_(existing.description || '');
    if (currentHash !== existingProps.mc_mirror_desc_hash) {
      description = existing.description || '';
      descHash = existingProps.mc_mirror_desc_hash; // still "what MirrorCal last authored"
    }
  }

  var privateProps = {
    mc_src_key: srcKey_(src.id, ev.id),
    mc_src_cal: src.id,
    mc_src_event_id: ev.id,
    mc_synced_at: new Date().toISOString(),
    mc_mirror_title: mirrorTitle,
    mc_mirror_color: mirrorColor || '',
    mc_mirror_desc_hash: descHash,
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

/** Has the owner changed this clone since MirrorCal last wrote it? */
function ownerEdited_(clone) {
  var props = (clone.extendedProperties && clone.extendedProperties.private) || {};
  if (props.mc_mirror_title !== undefined && stripCancelledPrefix_(clone.summary || '') !== props.mc_mirror_title) {
    return true;
  }
  if ((clone.colorId || '') !== (props.mc_mirror_color || '')) return true;
  if (props.mc_mirror_desc_hash !== undefined && hashText_(clone.description || '') !== props.mc_mirror_desc_hash) {
    return true;
  }
  return false;
}

/**
 * Cancelled source event: clones the owner never touched are deleted; edited
 * clones are the owner's records and are kept, marked [CANCELLED].
 */
function handleCancelled_(key) {
  var clone = findCloneByKey_(key);
  if (!clone) return;

  if (ownerEdited_(clone)) {
    if ((clone.summary || '').indexOf('[CANCELLED]') !== 0) {
      withBackoff_(function () {
        return Calendar.Events.patch(
          {
            summary: '[CANCELLED] ' + (clone.summary || ''),
            extendedProperties: { private: { mc_cancelled: 'true' } },
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
 * event no longer exists. Only touches events that carry our mc_src_key and
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
      if (!p.mc_src_key) return;           // not ours — never touch
      if (!sourceIds[p.mc_src_cal]) return; // source no longer configured — leave alone
      if (p.mc_cancelled === 'true') return;
      if (!seenKeys[p.mc_src_key]) handleCancelled_(p.mc_src_key);
    });
    pageToken = resp.nextPageToken || null;
  } while (pageToken);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

/**
 * Small stable hash (djb2, base36) of normalized text. Records what
 * description MirrorCal last authored on a clone. Kept in lockstep with
 * hashText in the @mirrorcal/core TypeScript library.
 */
function hashText_(s) {
  var h = 5381;
  var text = htmlToText_(s).trim();
  for (var i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

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
