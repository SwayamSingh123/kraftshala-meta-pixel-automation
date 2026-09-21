import './commands';

// Marketing pages pull in a lot of third-party script; their errors are not
// what this suite is testing, so they must not fail the run.
Cypress.on('uncaught:exception', () => false);
