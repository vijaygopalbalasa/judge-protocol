// Page wiring. All rendering goes through textContent-based helpers because job
// descriptions and RPC errors are attacker-controlled strings.
import { CFG, judgeStats, verifyJob, acpJobCounter } from './app.js';
import { el, set, safeLink } from './ui.js';

const $ = (s) => document.querySelector(s);
const short = (a) => (a ? a.slice(0, 10) + '…' + a.slice(-6) : '');
const ex = (path) => CFG.explorer + path;
const usdc = (v) => (Number(v) / 1e6).toFixed(2);

/* ---------------------------------- footer -------------------------------- */
set($('#addrs'), [
  el('span', { text: 'JudgeEvaluator ' }), safeLink(short(CFG.judge), ex('/address/' + CFG.judge), CFG.explorer),
  el('span', { text: ' · Hook ' }), safeLink(short(CFG.hook), ex('/address/' + CFG.hook), CFG.explorer),
  el('span', { text: ' · Canonical ERC-8183 ' }), safeLink(short(CFG.acp), ex('/address/' + CFG.acp), CFG.explorer),
]);

/* ------------------------------- measurement ------------------------------ */
const MEASURED = [
  ['Sample', '2,524 of 171,593 jobs', 'every 68th job id on the canonical contract'],
  ['Self-evaluated jobs', '70.6% ± 1.8pp', 'the party paying also decides whether the work passed'],
  ['Delegate to a third party', '29.4% ± 1.8pp', 'across 247 distinct evaluator addresses'],
  ['Third-party evaluators paid through', '54 addresses, 281 jobs', 'delegated evaluation already settles real money'],
  ['Rejection rate', '1.56% of decided jobs', 'the reject path is barely exercised in the wild'],
  ['Jobs using any hook', '0 of 2,524', 'a permission wall: only address(0) is whitelisted'],
  ['Median funded budget', '1.00 USDC', 'why percentage fees cannot work at this job size'],
];
set($('#measure'), MEASURED.map(([a, b, c]) => el('tr', {}, [
  el('td', { text: a }),
  el('td', { class: 'mono' }, [el('strong', { text: b })]),
  el('td', { class: 'note', text: c }),
])));

set($('#limits'), [
  el('strong', { text: 'Honest limits. ' }),
  el('span', {
    text: 'No third party has named this evaluator on their own job yet: every settled job shown here was '
      + 'posted by us. The ERC-8004 reputation hook is implemented and tested but not attachable, because the '
      + 'canonical contract gates hooks behind a whitelist that, of the addresses we checked, contains only '
      + 'address(0). There is no per-job fee surface in the contract, so per-evaluation pricing has to sit '
      + 'outside it. Deterministic checks cover objective, structured deliverables; subjective quality is '
      + 'deliberately out of scope for the trust path and is meant to escalate to a dispute layer instead.',
  }),
]);

/* ---------------------------------- stats --------------------------------- */
const statCard = (k, v, sm) => el('div', { class: 'card' }, [
  el('div', { class: 'k', text: k }),
  el('div', { class: sm ? 'v sm' : 'v', text: v }),
]);

async function loadStats() {
  set($('#stats'), [statCard('loading', '…')]);
  try {
    const [s, jc] = await Promise.all([judgeStats(), acpJobCounter()]);
    set($('#stats'), [
      statCard('Verdicts issued', String(s.verdicts)),
      statCard('Escrow released', String(s.completed)),
      statCard('Escrow refunded', String(s.rejected)),
      statCard('Paused', s.paused ? 'yes' : 'no'),
      statCard('Jobs on canonical ACP', jc.toLocaleString()),
      statCard('Guardian', short(s.guardian), true),
    ]);
  } catch (e) {
    set($('#stats'), [statCard('rpc error', e.message, true)]);
  }
}

/* --------------------------------- verify -------------------------------- */
const quick = $('#quick');
set(quick, [el('span', { text: 'try ' })].concat(
  CFG.knownJobs.flatMap((j, i) => [
    i ? el('span', { text: ', ' }) : null,
    el('a', { text: String(j), href: '#', data: { job: String(j) } }),
  ]).filter(Boolean)
));
quick.addEventListener('click', (e) => {
  const j = e.target instanceof HTMLElement ? e.target.dataset.job : null;
  if (!j) return;
  e.preventDefault();
  $('#jobInput').value = j;
  run();
});

function checkRow(c) {
  const lbl = el('div', { class: 'lbl' }, [el('span', { text: c.label })]);
  if (c.got && c.want && c.got !== c.want) {
    lbl.append(el('div', { class: 'hashes', text: `recomputed ${c.got}\non-chain   ${c.want}` }));
  } else if (c.got) {
    lbl.append(el('div', { class: 'hashes', text: c.got }));
  }
  return el('div', { class: 'check' }, [
    el('div', { class: 'mark ' + (c.ok ? 'ok' : 'no'), text: c.ok ? '✓' : '✗' }),
    lbl,
  ]);
}

function renderResult(r) {
  const v = r.verdict;
  const allOk = r.checks.length > 0 && r.checks.every((c) => c.ok);

  const left = el('div', {}, [
    el('div', { class: 'k', text: `job ${r.jobId} · status ${r.job.status}` }),
    el('div', { class: 'big' }, [
      el('span', { text: 'On-chain verdict: ' }),
      el('span', {
        class: 'pill ' + (v.pass ? 'pass' : 'fail'),
        text: v.pass ? 'PASS — escrow released' : 'REJECT — client refunded',
      }),
    ]),
    el('div', { class: 'note', text: `score ${v.score} / threshold ${v.threshold} · budget ${usdc(r.job.budget)} USDC` }),
  ]);
  const right = el('div', { style: 'text-align:right' }, [
    el('div', { class: 'big', style: `color:${allOk ? 'var(--ok)' : 'var(--bad)'}`, text: allOk ? 'VERIFIED' : 'MISMATCH' }),
    el('div', { class: 'note', text: allOk ? 'recomputed independently' : 'recomputation disagrees' }),
  ]);

  const box = el('div', { class: 'verdictbox' }, [
    el('div', { class: 'row', style: 'justify-content:space-between' }, [left, right]),
    el('div', { style: 'margin-top:14px' }, r.checks.map(checkRow)),
  ]);

  if (r.deliverableSource) {
    const p = el('p', { class: 'note', style: 'margin-top:12px' }, [
      el('span', { text: `Deliverable read from the provider's ${r.deliverableSource}` }),
    ]);
    if (r.submitTx) {
      p.append(el('span', { text: ' (' }), safeLink('submit tx', ex('/tx/' + r.submitTx), CFG.explorer), el('span', { text: ')' }));
    }
    p.append(el('span', { text: '.' }));
    box.append(p);
  }

  if (r.needsDeliverable) {
    const ta = el('textarea', { id: 'pasteD', rows: 3, placeholder: 'paste the deliverable text' });
    const btn = el('button', { class: 'ghost', text: 'Verify with pasted text' });
    const out = el('div');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r2 = await verifyJob(r.jobId, ta.value);
        const ok2 = r2.checks.every((c) => c.ok);
        set(out, [el('div', { class: 'verdictbox' }, [
          el('div', {
            class: 'big', style: `color:${ok2 ? 'var(--ok)' : 'var(--bad)'}`,
            text: ok2 ? 'VERIFIED with pasted deliverable' : 'Pasted content does not match the on-chain commitment',
          }),
        ].concat(r2.checks.map(checkRow)))]);
      } catch (e) {
        set(out, [el('p', { class: 'note', text: e.message })]);
      } finally { btn.disabled = false; }
    });
    box.append(
      el('p', {
        class: 'note', style: 'margin-top:12px',
        text: "The provider's deliverable is older than the RPC log window, so it could not be pulled "
          + 'automatically. Paste the deliverable text to finish verifying.',
      }),
      el('div', { class: 'row', style: 'margin-top:8px' }, [ta]),
      el('div', { class: 'row', style: 'margin-top:8px' }, [btn]),
      out,
    );
  }
  set($('#result'), [box]);
}

function errBox(title, msg) {
  set($('#result'), [el('div', { class: 'verdictbox' }, [
    el('div', { class: 'big', style: 'color:var(--bad)', text: title }),
    el('p', { class: 'note', text: msg }),
  ])]);
}

async function run() {
  const id = parseInt($('#jobInput').value, 10);
  if (!Number.isFinite(id) || id <= 0) { errBox('Invalid input', 'Enter a numeric job id.'); return; }
  $('#goBtn').disabled = true;
  set($('#result'), [el('p', {
    class: 'note',
    text: 'Reading the job, pulling the provider deliverable from calldata, recomputing hashes locally…',
  })]);
  try {
    const r = await verifyJob(id);
    if (r.error) errBox('Cannot verify', r.error);
    else renderResult(r);
  } catch (e) {
    errBox('Error', e.message);
  } finally {
    $('#goBtn').disabled = false;
  }
}
$('#goBtn').addEventListener('click', run);
$('#jobInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

loadStats();
