import {
  createCallSucceeded,
  getObservedProgramSlug,
  recordNote,
  recordStep,
  resetCapture,
  snapshot
} from '../support/pixel-capture';

const allPages = require('../fixtures/pages.json');

// Backend master OTP - accepted for any number on the test environment.
const MASTER_OTP = Cypress.env('otp') || '159753';

// Run a subset with:  npx cypress run --env platform=test,pages=mlp+basl
// Cypress splits --env on commas, so several ids are joined with "+" instead.
const only = String(Cypress.env('pages') || '')
  .split(/[+,|]/)
  .map((id) => id.trim())
  .filter(Boolean);
const pages = only.length ? allPages.filter((p) => only.includes(p.id)) : allPages;

const results = [];

describe('Meta Pixel tracking - Kraftshala course pages', () => {
  beforeEach(() => {
    cy.then(() => resetCapture());
  });

  // Runs even when the test fails, so a broken page still lands in the report
  // with whatever it managed to capture before it stopped.
  afterEach(function recordResult() {
    const page = this.currentTest.ctx.currentPage;
    if (!page) return;

    const failure = this.currentTest.state === 'failed' ? this.currentTest.err : null;
    cy.then(() => {
      const result = snapshot(page, {
        status: this.currentTest.state,
        error: failure ? failure.message : null,
        cleanup: this.currentTest.ctx.cleanupResults || []
      });

      // On a retry, keep the latest attempt rather than reporting the page twice.
      const existing = results.findIndex((r) => r.id === result.id);
      if (existing === -1) results.push(result);
      else results[existing] = result;
    });
  });

  after(() => {
    cy.task('writePixelReport', {
      results,
      generatedAt: new Date().toISOString(),
      baseUrl: Cypress.config('baseUrl'),
      platform: {
        id: Cypress.env('platform'),
        label: Cypress.env('platformLabel'),
        live: Cypress.env('platformLive'),
        site: Cypress.config('baseUrl')
      }
    }).then((file) => cy.task('log', `\nMeta Pixel report written to: ${file}\n`));
  });

  pages.forEach((page) => {
    it(`${page.name}`, function runPage() {
      this.currentPage = page;

      // 1. Fresh start - delete this page's lead and free its phone number.
      //    Asserted so the run can never quietly skip the cleanup and then
      //    reuse a lead left behind by an earlier run.
      cy.cleanupLead(page).then((cleanup) => {
        this.cleanupResults = cleanup;

        const removeLead = cleanup.find((c) => c.label === 'remove-lead');
        expect(removeLead, `delete-lead API was called for "${page.id}"`).to.not.equal(undefined);
        expect(removeLead.status, `delete-lead API reachable for "${page.id}"`).to.equal(200);

        const removeNumber = cleanup.find((c) => c.label === 'removeNumber');
        expect(removeNumber, `free-phone API was called for "${page.id}"`).to.not.equal(undefined);
      });

      // 2. Capture before anything loads, so PageView is caught.
      cy.startCapture();
      cy.then(() => recordStep('Landing page opened'));
      cy.visitPage(page);
      cy.dismissCookieBanner();

      // 3. Fill this page's own lead details.
      cy.fillLeadForm(page);

      // 4. Submit the details - this requests the OTP.
      cy.submitDetails();

      // 5. Enter the master OTP and verify.
      cy.submitOtp(MASTER_OTP);

      // 6. The lead is created once POST /lead/create comes back 2xx.
      cy.waitForLeadCreate(page).then((call) => {
        recordStep('Lead created');
        recordNote(`Create API response: ${call.responseBody}`);
        expect(call.status, `POST /lead/create responded ${call.status}: ${call.responseBody}`)
          .to.be.within(200, 299);
        expect(createCallSucceeded(), 'lead created').to.equal(true);
      });

      // 7. The program slug used for cleanup must match the one the page uses,
      //    otherwise the next run would start with a stale lead.
      cy.then(() => {
        const observed = getObservedProgramSlug();
        if (observed && observed !== page.programSlug) {
          throw new Error(
            `Program slug mismatch: page calls /program/${observed}/campaign/active but ` +
              `pages.json cleans up "${page.programSlug}". Update programSlug for "${page.id}".`
          );
        }
      });

      // 8. Let the conversion beacons settle before the snapshot is taken.
      cy.wait(4000);
    });
  });
});
