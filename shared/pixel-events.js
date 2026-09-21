/**
 * What each Meta Pixel event means, and which of them count as a conversion.
 *
 * Shared by the capture code that runs in the browser and the reporter that
 * runs in Node, so the two can never disagree.
 */

// Standard Meta conversion events.
const STANDARD_LEAD_EVENTS = [
  'Lead',
  'CompleteRegistration',
  'SubmitApplication',
  'Subscribe',
  'Purchase'
];

// Kraftshala's own naming: lead_mlp, lead_alm, lead_smbl, FormSubmitMLP,
// FormSubmitBASL, FormSubmitALM, ALMFormSubmit, CSM_LeadSubmit, ...
// step1_submit / step2_submit are progress markers, not conversions.
const CUSTOM_LEAD_EVENT = /^lead[_a-z0-9]*$|formsubmit|leadsubmit/i;

function isLeadEvent(event) {
  if (!event) return false;
  return STANDARD_LEAD_EVENTS.includes(event) || CUSTOM_LEAD_EVENT.test(event);
}

// Plain-English meaning for the events these pages fire.
const EVENT_DESCRIPTIONS = {
  PageView: 'Visitor opened the page',
  ViewContent: 'Visitor viewed key content',
  SubscribedButtonClick: 'Button click tracked automatically by Meta',
  Microdata: 'Page details collected automatically by Meta',
  step1_submit: 'Visitor submitted their contact details',
  step2_submit: 'Visitor submitted the OTP for verification',
  Lead: 'Standard Meta conversion - a lead was captured',
  CompleteRegistration: 'Standard Meta conversion - registration completed'
};

function describeEvent(event) {
  if (EVENT_DESCRIPTIONS[event]) return EVENT_DESCRIPTIONS[event];
  if (isLeadEvent(event)) return 'Conversion - lead captured for this programme';
  return '';
}

module.exports = {
  STANDARD_LEAD_EVENTS,
  CUSTOM_LEAD_EVENT,
  EVENT_DESCRIPTIONS,
  isLeadEvent,
  describeEvent
};
