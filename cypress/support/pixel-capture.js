/**
 * Capture store for one page run.
 *
 * Holds everything the report needs: the step timeline, every Meta Pixel beacon
 * that left the browser, every fbq() call the page made, every Kraftshala
 * backend call, and the result of every element lookup the run performed.
 */

import { isLeadEvent } from '../../shared/pixel-events';

const CREATE_LEAD_API = /\/lead\/create\b/i;

// Cypress bundles the support file and the spec separately, so importing this
// module from both would otherwise give each of them its own store and the
// spec would read an empty one. Parking the state on the shared spec-frame
// window keeps every importer pointed at the same object.
const STORE_KEY = '__kraftshalaPixelCapture';

function newState() {
  return {
    steps: [],
    beacons: [],
    fbqCalls: [],
    apiCalls: [],
    elementLookups: [],
    notes: []
  };
}

function state() {
  if (!globalThis[STORE_KEY]) globalThis[STORE_KEY] = newState();
  return globalThis[STORE_KEY];
}

export function resetCapture() {
  globalThis[STORE_KEY] = newState();
}

export function recordStep(name) {
  state().steps.push({ name, time: Date.now() });
}

export function recordBeacon(beacon) {
  state().beacons.push(beacon);
}

export function recordFbqCall(call) {
  state().fbqCalls.push(call);
}

export function recordApiCall(call) {
  state().apiCalls.push(call);
}

export function recordNote(text) {
  state().notes.push({ text, time: Date.now() });
}

/**
 * Opens an element lookup as "pending". It stays pending unless markElementFound
 * closes it, so anything Cypress gave up on is still in the log at the end of
 * the test and lands in the report as a missing element.
 */
export function openElementLookup(label, selectors) {
  const entry = { label, selectors, found: false, matchedSelector: null, time: Date.now() };
  state().elementLookups.push(entry);
  return entry;
}

export function markElementFound(entry, matchedSelector) {
  entry.found = true;
  entry.matchedSelector = matchedSelector;
  entry.resolvedInMs = Date.now() - entry.time;
}

export function getMissingElements() {
  return state().elementLookups.filter((e) => !e.found);
}

/**
 * Parse a facebook.com/tr beacon into a structured event.
 *
 * Small events go out as GET with everything in the query string; larger ones
 * go out as POST with the same fields form-encoded in the body, so both have
 * to be read or every POST event shows up as "(unknown)".
 */
export function parseBeacon(url, method, body) {
  const out = {
    event: '(unknown)',
    pixelId: '(n/a)',
    eventId: '',
    sourceUrl: '',
    customData: {},
    method,
    url,
    time: Date.now()
  };

  const sources = [];
  try {
    sources.push(new URL(url).searchParams);
  } catch (err) {
    out.parseError = String(err && err.message);
  }
  if (typeof body === 'string' && body) {
    try {
      sources.push(new URLSearchParams(body));
    } catch (err) {
      /* not form-encoded - the query string is all we have */
    }
  }

  for (const params of sources) {
    out.event = params.get('ev') || out.event;
    out.pixelId = params.get('id') || out.pixelId;
    out.eventId = params.get('eid') || out.eventId;
    out.sourceUrl = params.get('dl') || out.sourceUrl;
    for (const [key, value] of params.entries()) {
      // cd[content_name]=x  ->  customData.content_name = x
      if (key.startsWith('cd[') && key.endsWith(']')) out.customData[key.slice(3, -1)] = value;
    }
  }

  return out;
}

/** The POST /lead/create call, if the page made one. */
export function getCreateCall() {
  return state().apiCalls.find((c) => CREATE_LEAD_API.test(c.url) && c.method === 'POST');
}

export function createCallSucceeded() {
  const call = getCreateCall();
  return Boolean(call && call.status >= 200 && call.status < 300);
}

export function getLeadPixels() {
  return state().beacons.filter((b) => isLeadEvent(b.event));
}

/** The OTP verification call, if the page made one. */
export function getOtpValidateCall() {
  return state().apiCalls.find((c) => /\/otp-validation\/validate\b/i.test(c.url));
}

/**
 * When the phone number already belongs to a lead, /otp-validation/validate
 * answers with that lead instead of "SUCCESS" and the page takes its
 * existing-lead branch, so POST /lead/create never happens. Returns the email
 * of the lead that is holding the number, when it is not the one under test.
 */
export function getConflictingLeadEmail(expectedEmail) {
  const call = getOtpValidateCall();
  if (!call) return null;
  const match = /"email"\s*:\s*"([^"]+)"/.exec(call.responseBody || '');
  if (!match) return null;
  const found = match[1].toLowerCase();
  return found === String(expectedEmail).toLowerCase() ? null : found;
}

/**
 * Program slug the page actually asked for (program/<slug>/campaign/active).
 * Some shared components fire the same call with a literal "null" slug before
 * their config resolves, so those are skipped.
 */
export function getObservedProgramSlug() {
  for (const call of state().apiCalls) {
    const match = /\/program\/([a-z0-9_]+)\/campaign\/active/i.exec(call.url);
    if (match && match[1] !== 'null' && match[1] !== 'undefined') return match[1];
  }
  return null;
}

/** Deep copy of the current capture so a later reset cannot mutate it. */
export function snapshot(page, extra = {}) {
  return {
    id: page.id,
    name: page.name,
    path: page.path,
    programSlug: page.programSlug,
    expectedFormPageType: page.expectedFormPageType,
    lead: { ...page.lead },
    observedProgramSlug: getObservedProgramSlug(),
    createCall: getCreateCall() || null,
    leadCreated: createCallSucceeded(),
    steps: state().steps.map((s) => ({ ...s })),
    beacons: state().beacons.map((b) => ({ ...b, customData: { ...b.customData } })),
    fbqCalls: state().fbqCalls.map((c) => ({ ...c })),
    apiCalls: state().apiCalls.map((c) => ({ ...c })),
    elementLookups: state().elementLookups.map((e) => ({ ...e })),
    missingElements: getMissingElements().map((e) => ({ ...e })),
    notes: state().notes.map((n) => ({ ...n })),
    ...extra
  };
}

export { CREATE_LEAD_API, isLeadEvent };
