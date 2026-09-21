const fs = require('fs');
const path = require('path');
const { defineConfig } = require('cypress');
const generateReport = require('./reporter/generateReport');

const REPORTS_DIR = path.join(__dirname, 'cypress', 'reports');

/**
 * The two environments. They run the same pages, the same form and the same
 * cleanup API - only the hostnames differ.
 *
 * Pick one with:  npx cypress run --env platform=main
 */
const PLATFORMS = {
  test: {
    label: 'Test platform',
    site: 'https://testprogram.kraftshala.com',
    api: 'https://testservice.kraftshala.com',
    live: false
  },
  main: {
    label: 'Main platform (live)',
    // program.kraftshala.com redirects here; using the final host avoids a
    // cross-origin hop in the middle of cy.visit.
    site: 'https://www.kraftshala.com',
    api: 'https://service.kraftshala.com',
    live: true
  }
};

module.exports = defineConfig({
  e2e: {
    defaultCommandTimeout: 15000,
    pageLoadTimeout: 120000,
    requestTimeout: 20000,
    responseTimeout: 30000,
    video: false,
    screenshotOnRunFailure: true,
    // Clear the previous run's screenshots and videos as well.
    trashAssetsBeforeRuns: true,
    // These pages load a lot of third-party script; this reduces cross-origin flakiness.
    experimentalModifyObstructiveThirdPartyCode: true,
    // One retry: it lets the suite recover on its own after it has cleaned up a
    // stale lead that was holding a test phone number.
    retries: { runMode: 1, openMode: 0 },

    setupNodeEvents(on, config) {
      const name = String(config.env.platform || 'test').toLowerCase();
      const platform = PLATFORMS[name];
      if (!platform) {
        throw new Error(
          `Unknown platform "${name}". Use one of: ${Object.keys(PLATFORMS).join(', ')}`
        );
      }

      config.baseUrl = platform.site;
      config.env.platform = name;
      config.env.platformLabel = platform.label;
      config.env.platformLive = platform.live;
      config.env.apiBase = platform.api;

      // eslint-disable-next-line no-console
      console.log(`\nPlatform: ${platform.label}\n  site ${platform.site}\n  api  ${platform.api}\n`);

      const reportFile = path.join(REPORTS_DIR, `meta-pixel-report-${name}.html`);
      const rawFile = path.join(REPORTS_DIR, `meta-pixel-raw-${name}.json`);

      // Only ever keep the newest run: this platform's previous results are
      // deleted before the new run starts. (Cypress already trashes old
      // screenshots and videos itself.) The other platform's report is left
      // alone so the two stay independent.
      on('before:run', () => {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
        for (const file of fs.readdirSync(REPORTS_DIR)) {
          if (file === '.gitkeep') continue;
          if (file.includes(`-${name}.`) || file.includes(`-${name}-`)) {
            fs.rmSync(path.join(REPORTS_DIR, file), { force: true });
          }
        }
      });

      on('task', {
        // Writes the HTML report for the whole run, plus a JSON sidecar that
        // keeps the raw capture (API calls, selectors, timings) out of the
        // marketing-facing report but still available for debugging.
        writePixelReport(data) {
          fs.mkdirSync(REPORTS_DIR, { recursive: true });
          fs.writeFileSync(reportFile, generateReport(data), 'utf8');
          fs.writeFileSync(rawFile, JSON.stringify(data, null, 2), 'utf8');
          return reportFile;
        },
        log(message) {
          console.log(message);
          return null;
        }
      });

      return config;
    }
  }
});
