const { describeEvent, isLeadEvent } = require('../shared/pixel-events');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The step a timestamped event belongs to. */
function phaseFor(time, steps) {
  let phase = steps.length ? steps[0].name : 'Landing page opened';
  for (const step of steps) {
    if (time >= step.time) phase = step.name;
    else break;
  }
  return phase;
}

/**
 * A beacon is timestamped when it hits the network, which can be a moment after
 * the screen has already moved on - that would file an event under the wrong
 * step. Where the page's own fbq() call is known, its time is the honest one,
 * so the latest matching call at or before the beacon wins.
 */
function actionTimeOf(beacon, fbqCalls) {
  let best = null;
  for (const call of fbqCalls) {
    if (call.event !== beacon.event) continue;
    if (call.pixelId && beacon.pixelId !== '(n/a)' && call.pixelId !== beacon.pixelId) continue;
    if (call.time > beacon.time || beacon.time - call.time > 8000) continue;
    if (!best || call.time > best.time) best = call;
  }
  return best ? best.time : beacon.time;
}

/** Groups a step's events by name, collecting which pixel ids fired each one. */
function groupEvents(beacons) {
  const byEvent = new Map();
  beacons.forEach((b) => {
    if (!byEvent.has(b.event)) byEvent.set(b.event, new Map());
    const pixels = byEvent.get(b.event);
    pixels.set(b.pixelId, (pixels.get(b.pixelId) || 0) + 1);
  });
  return [...byEvent.entries()].map(([event, pixels]) => ({ event, pixels }));
}

function renderProgramme(page, index) {
  const fbqCalls = page.fbqCalls || [];
  const beacons = page.beacons.map((b) => ({
    ...b,
    phase: phaseFor(actionTimeOf(b, fbqCalls), page.steps)
  }));

  const byPhase = new Map();
  beacons.forEach((b) => {
    if (!byPhase.has(b.phase)) byPhase.set(b.phase, []);
    byPhase.get(b.phase).push(b);
  });

  const rows = page.steps
    .map((step, i) => {
      const stepRow = `<tr class="step-row">
        <td colspan="2"><span class="num">${i + 1}</span>${esc(step.name)}</td>
      </tr>`;

      const events = groupEvents(byPhase.get(step.name) || []);
      if (!events.length) {
        return stepRow + '<tr><td class="none" colspan="2">No pixel fired here</td></tr>';
      }

      return (
        stepRow +
        events
          .map(({ event, pixels }) => {
            const conversion = isLeadEvent(event);
            const meaning = describeEvent(event);
            const ids = [...pixels.entries()]
              .map(
                ([id, n]) =>
                  `<div>${esc(id)}${n > 1 ? ` <span class="x">&times;${n}</span>` : ''}</div>`
              )
              .join('');
            return `<tr class="${conversion ? 'conv' : ''}">
              <td>
                <span class="event">${esc(event)}</span>
                ${conversion ? '<span class="tag">Conversion</span>' : ''}
                ${meaning ? `<div class="meaning">${esc(meaning)}</div>` : ''}
              </td>
              <td class="ids">${ids}</td>
            </tr>`;
          })
          .join('')
      );
    })
    .join('');

  const removeLead = (page.cleanup || []).find((c) => c.label === 'remove-lead');
  const cleanupLine = !removeLead
    ? 'Cleanup did not run'
    : /success/i.test(removeLead.message)
      ? 'Previous test lead deleted before this run'
      : 'No previous test lead to delete';

  const result = page.leadCreated
    ? `<div class="result ok"><span>&#10003;</span> Lead created for this programme</div>`
    : `<div class="result bad"><span>&#33;</span> Lead was not created for this programme</div>`;

  return `<section class="prog" id="prog-${index}">
    <h2>${index + 1}. ${esc(page.name)}</h2>
    <div class="path">${esc(page.path)}</div>
    ${result}
    <div class="fresh">${esc(cleanupLine)}</div>
    <table>
      <thead><tr><th>Pixel event</th><th>Fired by pixel ID</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

module.exports = function generateReport({
  results = [],
  generatedAt = new Date().toISOString(),
  platform = {}
}) {
  const totalEvents = results.reduce((n, p) => n + p.beacons.length, 0);
  const leadsCreated = results.filter((p) => p.leadCreated).length;

  const when = new Date(generatedAt);
  const stamp = Number.isNaN(when.getTime())
    ? generatedAt
    : when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const host = platform.site ? String(platform.site).replace(/^https?:\/\//, '') : '';
  const platformBadge = platform.label
    ? `<span class="env ${platform.live ? 'live' : 'testenv'}">${esc(platform.label)}</span>`
    : '';

  const summaryRows = results
    .map(
      (p, i) => `<tr>
        <td><a href="#prog-${i}">${esc(p.name)}</a></td>
        <td class="mid">${p.beacons.length}</td>
        <td class="mid">${
          p.leadCreated
            ? '<span class="pill ok">Lead created</span>'
            : '<span class="pill bad">Not created</span>'
        }</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meta Pixel Report - Kraftshala${platform.label ? ` (${esc(platform.label)})` : ''}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  /* Kraftshala brand: gold #f1ae13, navy #243e60 */
  --gold:#f1ae13; --gold-dark:#d1950a; --gold-soft:#fdf4e0;
  --navy:#243e60; --navy-deep:#1b2f4a;
  --ink:#303030; --body:#505050; --muted:#7e7e7e;
  --line:#e5e5e5; --line-soft:#f1f1f1; --bg:#f8f8f8;
  --ok:#157a4f; --ok-soft:#eaf6f0;
  --bad:#c0392b; --bad-soft:#fdecea;
  --font:"Plus Jakarta Sans","Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--body);font-family:var(--font);
  line-height:1.55;-webkit-font-smoothing:antialiased}

/* ---------------- header ---------------- */
header{background:linear-gradient(135deg,var(--navy) 0%,var(--navy-deep) 100%);
  color:#fff;padding:36px 24px 30px;position:relative;overflow:hidden}
header:after{content:"";position:absolute;right:-70px;top:-70px;width:240px;height:240px;
  border-radius:50%;background:var(--gold);opacity:.13}
.wrap{max-width:880px;margin:0 auto;position:relative}
.brandline{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brandmark{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:13px;
  letter-spacing:.02em;color:#fff}
.brandmark i{width:10px;height:10px;border-radius:2px;background:var(--gold);
  transform:rotate(45deg);display:inline-block}
.env{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  padding:4px 11px;border-radius:999px}
.env.testenv{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.3)}
.env.live{background:var(--gold);color:#3d2c00}
header h1{margin:16px 0 6px;font-size:29px;font-weight:800;letter-spacing:-.5px;color:#fff}
header p{margin:0;color:#b9c4d4;font-size:13px}
header p b{color:#fff;font-weight:600}
.stats{display:flex;gap:40px;margin-top:26px;flex-wrap:wrap}
.stats b{display:block;font-size:27px;font-weight:800;line-height:1.15;color:#fff}
.stats span{color:#b9c4d4;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em}
.stats .hl b{color:var(--gold)}

main{max-width:880px;margin:0 auto;padding:26px 24px}

/* ---------------- cards ---------------- */
.card,.prog{background:#fff;border:1px solid var(--line);border-radius:14px;
  box-shadow:0 1px 3px rgba(36,62,96,.05);margin-bottom:20px}
.card{padding:22px 24px}
.prog{padding:22px 24px 24px;scroll-margin-top:16px;border-top:3px solid var(--gold)}
.card h2{margin:0 0 15px;font-size:14px;font-weight:800;color:var(--ink);
  text-transform:uppercase;letter-spacing:.07em}
.prog h2{margin:0 0 4px;font-size:19px;font-weight:800;color:var(--ink);letter-spacing:-.2px}
.path{color:var(--muted);font-size:12px;margin-bottom:16px;font-family:var(--mono);word-break:break-all}

.result{display:flex;align-items:center;gap:10px;padding:12px 15px;border-radius:10px;
  font-size:15px;font-weight:700}
.result span{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;
  color:#fff;font-size:12px;flex:none}
.result.ok{background:var(--ok-soft);color:#0f5f3d}
.result.ok span{background:var(--ok)}
.result.bad{background:var(--bad-soft);color:#932a1e}
.result.bad span{background:var(--bad)}
.fresh{color:var(--muted);font-size:12px;margin:9px 0 18px}

/* ---------------- tables ---------------- */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);padding:0 14px 9px;border-bottom:2px solid var(--line)}
th:last-child,td:last-child{width:195px}
td{padding:12px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tbody tr:last-child td{border-bottom:none}

.step-row td{background:var(--navy);color:#fff;font-weight:700;font-size:13px;padding:10px 14px}
.num{display:inline-grid;place-items:center;width:21px;height:21px;border-radius:50%;
  background:var(--gold);color:#3d2c00;font-size:11px;font-weight:800;margin-right:10px}

.event{font-family:var(--mono);font-weight:700;font-size:13px;color:var(--ink)}
.meaning{color:var(--muted);font-size:12px;margin-top:3px}
.ids{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
.ids div{padding:1px 0}
.x{color:var(--muted)}
.none{color:var(--muted);font-style:italic;font-size:12.5px}

tr.conv td{background:var(--ok-soft)}
tr.conv .event{color:#0f5f3d}
tr.conv .meaning{color:#3f7a62}
.tag{margin-left:9px;font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  background:var(--ok);color:#fff;border-radius:999px;padding:3px 8px;vertical-align:1.5px}

.mid{text-align:center}
.card a{color:var(--ink);font-weight:600;text-decoration:none;border-bottom:1.5px solid var(--gold)}
.card a:hover{color:var(--navy)}
.pill{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;
  padding:4px 11px;white-space:nowrap}
.pill.ok{background:var(--ok-soft);color:#0f5f3d}
.pill.bad{background:var(--bad-soft);color:#932a1e}

footer{max-width:880px;margin:0 auto;padding:4px 24px 44px;color:var(--muted);font-size:12px}

@media (max-width:620px){
  header{padding:26px 16px 24px}
  header h1{font-size:23px}
  .stats{gap:24px}
  th:last-child,td:last-child{width:auto}
  main,footer{padding-left:14px;padding-right:14px}
  .prog,.card{padding:18px 15px 20px}
}
@media print{body{background:#fff}.prog,.card{break-inside:avoid;box-shadow:none}}
</style></head>
<body>

<header><div class="wrap">
  <div class="brandline">
    <span class="brandmark"><i></i>KRAFTSHALA</span>
    ${platformBadge}
  </div>
  <h1>Meta Pixel Report</h1>
  <p>${host ? `<b>${esc(host)}</b> &middot; ` : ''}${esc(stamp)}</p>
  <div class="stats">
    <div><b>${results.length}</b><span>Programmes</span></div>
    <div class="hl"><b>${leadsCreated} / ${results.length}</b><span>Leads created</span></div>
    <div><b>${totalEvents}</b><span>Pixel events</span></div>
  </div>
</div></header>

<main>
  <div class="card">
    <h2>Summary</h2>
    <table>
      <thead><tr><th>Programme</th><th class="mid">Pixel events</th><th class="mid">Result</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
  </div>

  ${results.map((p, i) => renderProgramme(p, i)).join('')}
</main>

<footer>Each programme was filled in and submitted end to end on
${esc(platform.label || 'the platform')}. The previous test lead is deleted before every run,
so each result comes from a fresh submission.</footer>

</body></html>`;
};
