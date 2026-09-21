import {
  getConflictingLeadEmail,
  getCreateCall,
  getOtpValidateCall,
  markElementFound,
  openElementLookup,
  parseBeacon,
  recordApiCall,
  recordBeacon,
  recordFbqCall,
  recordNote,
  recordStep
} from './pixel-capture';

// Set per platform in cypress.config.js (test -> testservice, main -> service).
const API_BASE = Cypress.env('apiBase') || 'https://testservice.kraftshala.com';
const API_URL_PATTERN = new RegExp(
  `^https?://${new URL(API_BASE).host.replace(/\./g, '\\.')}/`
);

/**
 * Every page renders the same lead-form component but with different ids, so
 * each element gets a small ordered list of candidate selectors that together
 * cover all pages. If none of them match, the run reports exactly what it tried.
 */
export const SELECTORS = {
  nameField: ['input[name="name"]'],
  emailField: ['input[name="email"]'],
  // The server-rendered markup ships a readonly placeholder input; the real
  // react-phone-number-input replaces it on hydration.
  phoneField: ['input.PhoneInputInput[type="tel"]:not([readonly])'],
  // "Get screening test details on WhatsApp" - the radio group is named
  // opt_in on some pages and marketing_exp on others. The real <input> is
  // styled away behind a custom control, so it is never :visible.
  optInYes: [
    'input[name="opt_in"][value="Yes"]',
    'input[name="marketing_exp"][value="Yes"]'
  ],
  submitButton: ['button.submit-btn[type="submit"]'],
  otpInput: ['input.otp-input'],
  otpVerifyButton: ['button.verify-otp-btn']
};

function summarize(body, max = 1500) {
  if (body == null) return '';
  let text;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body);
  } catch (err) {
    text = String(body);
  }
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...[truncated]' : text;
}

// ---------------------------------------------------------------------------
// Step 1 - wipe the lead so every run starts from a clean slate
// ---------------------------------------------------------------------------

/**
 * Deletes the lead and frees the phone number. These go through cy.request, not
 * the browser, so they never pollute the captured pixel / API data.
 */
Cypress.Commands.add('cleanupLead', (page) => {
  const { email, phone } = page.lead;
  const targets = [
    {
      label: 'remove-lead',
      url: `${API_BASE}/lead/remove-lead/${page.programSlug}/${encodeURIComponent(email)}`
    },
    {
      label: 'removeNumber',
      url: `${API_BASE}/otp-validation/removeNumber/${encodeURIComponent(phone)}`
    },
    // The backend keeps an email -> phone binding that can only be cleared by
    // number, so any number this page used before has to be freed as well or
    // the OTP step rejects the new one.
    ...(page.lead.retiredPhones || []).map((old) => ({
      label: `removeNumber (retired ${old})`,
      url: `${API_BASE}/otp-validation/removeNumber/${encodeURIComponent(old)}`
    }))
  ];

  const results = [];
  targets.forEach((target) => {
    cy.request({ method: 'GET', url: target.url, failOnStatusCode: false }).then((res) => {
      const message = (res.body && res.body.message) || res.status;
      results.push({
        label: target.label,
        url: target.url,
        status: res.status,
        message: String(message)
      });
      cy.task('log', `  cleanup ${target.label} -> ${res.status} ${message}`);
    });
  });

  return cy.wrap(results, { log: false });
});

// ---------------------------------------------------------------------------
// Step 2 - capture everything the page sends
// ---------------------------------------------------------------------------

Cypress.Commands.add('startCapture', () => {
  // Meta Pixel beacons - the ground truth for "which pixel fired when".
  cy.intercept({ url: /facebook\.com\/tr\b/ }, (req) => {
    recordBeacon(parseBeacon(req.url, req.method, req.body));
    req.continue();
  }).as('metaPixel');

  // Kraftshala backend calls the page makes, including POST /lead/create.
  cy.intercept({ url: API_URL_PATTERN }, (req) => {
    const startedAt = Date.now();
    req.continue((res) => {
      recordApiCall({
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        requestBody: summarize(req.body),
        responseBody: summarize(res.body),
        time: Date.now()
      });
    });
  }).as('backend');
});

/**
 * Visits the page with window.fbq wrapped so every fbq(...) call is recorded
 * even if the beacon itself never leaves the browser. The property must read as
 * undefined until the page assigns it: the Meta snippet bails out early when
 * window.fbq already exists, which would stop the real pixel initialising.
 */
Cypress.Commands.add('visitPage', (page) => {
  cy.visit(page.path, {
    onBeforeLoad(win) {
      let wrapped;
      Object.defineProperty(win, 'fbq', {
        configurable: true,
        get: () => wrapped,
        set(realFbq) {
          wrapped = new Proxy(realFbq, {
            apply(target, thisArg, args) {
              const method = String(args[0]);
              const perPixel = /single/i.test(method); // trackSingle / trackSingleCustom
              recordFbqCall({
                method,
                pixelId: perPixel ? String(args[1] || '') : '',
                event: perPixel ? String(args[2] || '') : String(args[1] || ''),
                payload: summarize(Array.prototype.slice.call(args, perPixel ? 3 : 2), 400),
                time: Date.now()
              });
              return Reflect.apply(target, thisArg, args);
            }
          });
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Element resolution - the single place that decides whether an element exists
// ---------------------------------------------------------------------------

/**
 * Smallest ancestor of the visible name field that also holds the email, phone
 * and submit controls. Scoping to it stops us mixing fields from two different
 * copies of the form if a page renders both a desktop and a mobile one.
 */
function findFormRoot($body) {
  const $names = $body.find(SELECTORS.nameField[0]).filter(':visible');
  if (!$names.length) return null;

  const body = $body.get(0);
  let el = $names.get(0);
  while (el && el !== body) {
    const $el = Cypress.$(el);
    const complete =
      $el.find(SELECTORS.emailField[0]).length &&
      $el.find('input.PhoneInputInput').length &&
      $el.find(SELECTORS.submitButton[0]).length;
    if (complete) return $el;
    el = el.parentElement;
  }
  return null;
}

Cypress.Commands.add('getFormRoot', (timeout = 40000) => {
  const lookup = openElementLookup('Lead form container', [
    'closest ancestor of input[name="name"] containing input[name="email"] + input.PhoneInputInput + button.submit-btn[type="submit"]'
  ]);

  return cy
    .get('body', { timeout, log: false })
    .should(($body) => {
      if (!findFormRoot($body)) throw new Error('lead form container not rendered yet');
    })
    .then(($body) => {
      markElementFound(lookup, 'form container');
      return cy.wrap(findFormRoot($body), { log: false });
    });
});

/**
 * Resolves the first visible element matching any candidate selector. The lookup
 * is logged before the search starts and only closed once something matched, so
 * anything Cypress never resolved shows up in the report as a missing element
 * together with the exact selectors that were tried.
 */
Cypress.Commands.add('findElement', (label, candidates, options = {}) => {
  const { timeout = 20000, within = null, requireVisible = true } = options;
  const selectors = [].concat(candidates);
  const lookup = openElementLookup(label, selectors);

  const scope = () =>
    within
      ? cy.wrap(within, { log: false, timeout })
      : cy.get('body', { log: false, timeout });

  // Prefer a visible match. Controls that are deliberately styled away - the
  // custom radios, for example - opt out with requireVisible: false.
  const pick = ($scope) => {
    for (const selector of selectors) {
      const $visible = $scope.find(selector).filter(':visible');
      if ($visible.length) return { $match: $visible.first(), selector };
    }
    if (requireVisible) return null;
    for (const selector of selectors) {
      const $any = $scope.find(selector);
      if ($any.length) return { $match: $any.first(), selector };
    }
    return null;
  };

  return scope()
    .should(($scope) => {
      if (!pick($scope)) {
        throw new Error(`[element not found] ${label} - tried: ${selectors.join(' | ')}`);
      }
    })
    .then(($scope) => {
      const hit = pick($scope);
      markElementFound(lookup, hit.selector);
      return cy.wrap(hit.$match, { log: false });
    });
});

// ---------------------------------------------------------------------------
// Step 3 - fill and submit the lead form
// ---------------------------------------------------------------------------

/**
 * Types with { force: true } because these pages park sticky CTAs and chat
 * widgets over the form. Each field is asserted straight afterwards, so forcing
 * the interaction never hides a field that failed to take the value.
 */
function fillField($el, value) {
  return cy.wrap($el, { log: false }).clear({ force: true }).type(value, { force: true });
}

Cypress.Commands.add('fillLeadForm', (page) => {
  const { lead } = page;

  cy.getFormRoot().then(($form) => {
    cy.wrap($form, { log: false }).scrollIntoView();

    cy.findElement('Name field', SELECTORS.nameField, { within: $form })
      .then(($el) => fillField($el, lead.name))
      .should('have.value', lead.name);

    cy.findElement('Email field', SELECTORS.emailField, { within: $form })
      .then(($el) => fillField($el, lead.email))
      .should('have.value', lead.email);

    // The widget supplies the +91 country code, so only digits are typed here.
    cy.findElement('Phone field', SELECTORS.phoneField, { within: $form })
      .then(($el) => fillField($el, lead.phone))
      .should(($el) => {
        expect(String($el.val()).replace(/\D/g, ''), 'phone digits').to.contain(lead.phone);
      });

    cy.findElement('WhatsApp opt-in "Yes"', SELECTORS.optInYes, {
      within: $form,
      requireVisible: false
    })
      .check({ force: true })
      .should('be.checked');
  });

  cy.then(() => recordStep('Lead form filled'));
});

Cypress.Commands.add('submitDetails', () => {
  cy.getFormRoot().then(($form) => {
    cy.findElement('Submit button', SELECTORS.submitButton, { within: $form })
      .should('not.be.disabled')
      .then(($btn) => {
        recordNote(`Submit button label: "${$btn.text().trim()}"`);
        recordStep('Details submitted');
        cy.wrap($btn, { log: false }).click({ force: true });
      });
  });
});

Cypress.Commands.add('submitOtp', (otp) => {
  cy.findElement('OTP input', SELECTORS.otpInput, { timeout: 45000 }).then(($input) => {
    recordStep('OTP screen shown');
    cy.wrap($input, { log: false }).scrollIntoView();
    fillField($input, otp).should('have.value', otp);
  });

  cy.findElement('Verify OTP button', SELECTORS.otpVerifyButton)
    .should('not.be.disabled')
    .then(($btn) => {
      recordStep('OTP verified');
      cy.wrap($btn, { log: false }).click({ force: true });
    });
});

// ---------------------------------------------------------------------------
// Step 4 - confirm the lead was actually created
// ---------------------------------------------------------------------------

/**
 * Polls until POST /lead/create lands. If it never does, the most likely reason
 * is that the phone number is still attached to an older lead under a different
 * email: the backend answers /otp-validation/validate with that lead and the
 * page takes its existing-lead branch instead of creating one. That stale lead
 * is removed here so the retry - and every later run - starts clean.
 */
Cypress.Commands.add('waitForLeadCreate', (page, timeoutMs = 45000) => {
  const interval = 1000;

  const poll = (remaining) => {
    if (getCreateCall()) return cy.wrap(getCreateCall(), { log: false });
    if (remaining <= 0) return cy.then(() => explainMissingCreate(page));
    return cy.wait(interval, { log: false }).then(() => poll(remaining - interval));
  };

  const explainMissingCreate = () => {
    const validate = getOtpValidateCall();

    // The backend refuses the OTP when the email is still bound to an older
    // number. Only the number itself can clear that binding.
    const bound = /phone number associated with .+? is x*(\d{3,4})/i.exec(
      (validate && validate.responseBody) || ''
    );
    if (bound) {
      throw new Error(
        `POST /lead/create was never called: ${page.lead.email} is still bound to an older ` +
          `phone number ending ${bound[1]}, so the OTP for ${page.lead.phone} was rejected. ` +
          `Add that old number to "retiredPhones" for page "${page.id}" in ` +
          `cypress/fixtures/pages.json (or call GET ${API_BASE}/otp-validation/removeNumber/<old number> once). ` +
          `Backend said: ${validate.responseBody}`
      );
    }

    const conflict = getConflictingLeadEmail(page.lead.email);
    if (!conflict) {
      throw new Error(
        'POST /lead/create was never called. ' +
          (validate
            ? `/otp-validation/validate responded ${validate.status}: ${validate.responseBody}`
            : '/otp-validation/validate was never called either - the OTP step did not go through.')
      );
    }

    const url = `${API_BASE}/lead/remove-lead/${page.programSlug}/${encodeURIComponent(conflict)}`;
    return cy.request({ method: 'GET', url, failOnStatusCode: false }).then((res) => {
      recordNote(`Removed stale lead ${conflict} holding phone ${page.lead.phone} (${res.status})`);
      throw new Error(
        `Phone ${page.lead.phone} was still attached to lead "${conflict}", so the page reused ` +
          `that lead instead of creating one and POST /lead/create never fired. That lead has ` +
          `now been deleted (${res.status}) - re-run and this page will create its lead.`
      );
    });
  };

  return cy.then(() => poll(timeoutMs));
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

Cypress.Commands.add('dismissCookieBanner', () => {
  cy.get('body', { log: false }).then(($body) => {
    const $btn = $body
      .find('#onetrust-accept-btn-handler, button:contains("Accept"), button:contains("Allow")')
      .filter(':visible');
    if ($btn.length) cy.wrap($btn.first(), { log: false }).click({ force: true });
  });
});
