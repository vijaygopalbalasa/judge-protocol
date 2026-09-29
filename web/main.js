// Page wiring. All rendering goes through textContent-based helpers because job
// descriptions and RPC errors are attacker-controlled strings.
import { CFG, judgeStats, verifyJob, acpJobCounter, parseJobId } from './app.js';
import { present, pasteHeadline } from './present.js';
import { MEASURED } from './measurement.js';
import { el, set, safeLink } from './ui.js';

const $ = (s) => document.querySelector(s);
const short = (a) => (a ? a.slice(0, 10) + '…' + a.slice(-6) : '');
const ex = (path) => CFG.explorer + path;
const usdc = (v) => (Number(v) / 1e6).toFixed(2);

/* ---------------------------------- footer -------------------------------- */
set($('#addrs'), [
  el('span', { text: `${CFG.label}: JudgeEvaluator ` }), safeLink(short(CFG.judge), ex('/address/' + CFG.judge), CFG.explorer),
  ...(CFG.hook ? [el('span', { text: ' · Hook ' }), safeLink(short(CFG.hook), ex('/address/' + CFG.hook), CFG.explorer)] : []),
  el('span', { text: ` · ${CFG.acpLabel} ` }), safeLink(short(CFG.acp), ex('/address/' + CFG.acp), CFG.explorer),
]);

/* ------------------------------- measurement ------------------------------ */

set($('#measure'), MEASURED.map(([a, b, c]) => el('tr', {}, [
  el('td', { text: a }),
  el('td', { class: 'mono' }, [el('strong', { text: b })]),
  el('td', { class: 'note', text: c }),
])));

const MAINNET_LIMITS = 'On Arc mainnet since 2026-09-28. Circle has no ERC-8183 contract on Arc mainnet, so the judge '
  + 'serves the escrow ArcBounty deployed there, the same code Circle runs on Arc testnet. Its only rulings so far '
  + 'are two zero-budget '
  + 'test jobs of our own (jobs 16 and 17), and the hosted judge still rules on Arc testnet only, so nobody can '
  + 'ask it for a mainnet ruling from this page yet. Deterministic checks cover objective, structured '
  + 'deliverables; subjective quality is deliberately out of scope for the trust path.';
set($('#limits'), [
  el('strong', { text: 'Honest limits. ' }),
  CFG.network === 'arc-mainnet' ? el('span', { text: MAINNET_LIMITS }) : el('span', {
    text: 'The judge runs on demand plus a daily sweep on Arc testnet: after a provider submits, anyone can '
      + 'ask it to rule (judge-protocol-api.vercel.app), and the sweep catches jobs nobody asked about. It is '
      + 'best effort with no uptime guarantee; if it never rules, claimRefund after the job expires returns '
      + 'the client\'s funds. '
      + 'No third party has named this evaluator on their own job yet: every settled job shown here was '
      + 'posted by us. The ERC-8004 reputation hook is implemented and tested but not attachable, because the '
      + 'canonical contract gates hooks behind a whitelist that, of the addresses we checked, contains only '
      + 'address(0). There is no per-job fee surface in the contract, so per-evaluation pricing has to sit '
      + 'outside it. Deterministic checks cover objective, structured deliverables; subjective quality is '
      + 'deliberately out of scope for the trust path and is meant to escalate to a dispute layer instead.',
  }),
]);

/* -------------------------------- rpc mode ------------------------------- */
// Say which path the chain data takes, so a visitor who chose direct mode can
// see it took effect.
{
  const relay = CFG.rpc === '/api/rpc';
  const other = CFG.network === 'arc-mainnet'
    ? el('a', { text: 'switch to Arc testnet', href: '?' })
    : el('a', { text: 'switch to Arc mainnet', href: '?network=arc-mainnet' });
  set($('#rpcmode'), [
    ...(CFG.unknownNetwork ? [el('strong', { text: `Unknown network "${CFG.unknownNetwork}", showing Arc testnet. ` })] : []),
    el('span', { text: `Network: ${CFG.label} (` }), other, el('span', { text: '). ' }),
    ...(relay
      ? [el('span', { text: 'Chain data from: the read-only /api/rpc relay on this site (' }),
        el('a', { text: 'read the Arc RPC directly', href: '?rpc=direct' }), el('span', { text: ').' })]
      : [el('span', { text: `Chain data from: ${CFG.rpc} (direct).` })]),
  ]);
}

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
      statCard(CFG.network === 'arc-mainnet' ? 'Jobs on the escrow' : 'Jobs on canonical ACP', jc.toLocaleString()),
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

function detailList(results) {
  if (!results || !results.length) return null;
  return el('div', { class: 'note', style: 'margin-top:10px' }, results.map((x) => el('div', {
    class: 'mono', text: `${x.kind}${x.weight !== 1 ? ` (weight ${x.weight})` : ''}: ${x.unsupported ? 'not replayable' : x.pass ? 'pass' : 'fail'}, ${x.detail}`,
  })));
}

function renderResult(r) {
  const v = r.verdict;
  const p = present(r);

  const left = el('div', {}, [
    el('div', { class: 'k', text: `job ${r.jobId} · status ${r.job.status}` }),
    el('div', { class: 'big' }, [
      el('span', { text: 'On-chain verdict: ' }),
      el('span', { class: 'pill ' + (v.pass ? 'pass' : 'fail'), text: p.pill }),
    ]),
    el('div', { class: 'note', text: `score ${v.score} / threshold ${v.threshold} · budget ${usdc(r.job.budget)} USDC` }),
  ]);
  const right = el('div', { style: 'text-align:right' }, [
    el('div', { class: 'big', style: `color:${p.color}`, text: p.headline }),
    el('div', { class: 'note', text: p.note }),
  ]);

  const box = el('div', { class: 'verdictbox' }, [
    el('div', { class: 'row', style: 'justify-content:space-between' }, [left, right]),
    el('div', { style: 'margin-top:14px' }, r.checks.map(checkRow)),
  ]);
  const details = detailList(r.results);
  if (details) box.append(details);

  if (p.sourceText) {
    const para = el('p', { class: 'note', style: 'margin-top:12px' }, [el('span', { text: p.sourceText })]);
    if (r.submitTx) {
      para.append(el('span', { text: ' (' }), safeLink('submit tx', ex('/tx/' + r.submitTx), CFG.explorer), el('span', { text: ')' }));
    }
    para.append(el('span', { text: '.' }));
    box.append(para);
  }

  if (p.incompleteText) {
    box.append(el('p', { class: 'note', style: 'margin-top:12px', text: p.incompleteText }));
  }

  if (p.canPaste) {
    const ta = el('textarea', { id: 'pasteD', rows: 3, placeholder: 'paste the deliverable text' });
    const btn = el('button', { class: 'ghost', text: 'Verify with pasted text' });
    // A file is hashed as its exact bytes: the only way to check binary content,
    // or text whose line endings a text box would normalize.
    const file = el('input', { id: 'fileD', type: 'file' });
    const out = el('div');
    const TONE = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)' };
    const check = async (input) => {
      btn.disabled = true; file.disabled = true;
      try {
        const r2 = await verifyJob(r.jobId, input);
        const h = pasteHeadline(r2); // never "verified" for an empty or partial check list
        const src = present(r2).sourceText;
        set(out, [el('div', { class: 'verdictbox' }, [
          el('div', { class: 'big', style: `color:${TONE[h.tone] || TONE.bad}`, text: h.text }),
        ].concat(r2.checks.map(checkRow), [detailList(r2.results)].filter(Boolean),
          src ? [el('p', { class: 'note', text: src + '.' })] : []))]);
      } catch (e) {
        set(out, [el('p', { class: 'note', text: e.message })]);
      } finally { btn.disabled = false; file.disabled = false; }
    };
    btn.addEventListener('click', () => check(ta.value));
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (f) check(new Uint8Array(await f.arrayBuffer()));
    });
    box.append(
      el('div', { class: 'row', style: 'margin-top:8px' }, [ta]),
      el('div', { class: 'row', style: 'margin-top:8px' }, [btn, el('span', { class: 'note', text: 'or choose the file:' }), file]),
      out,
    );
  }
  set($('#result'), [box]);
}

function renderAwaiting(r) {
  const p = present(r);
  const status = el('div', { class: 'note' });
  const btn = el('button', { text: 'Ask the judge to rule now' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    set(status, [el('span', { text: 'Asking the judge… it checks the delivery and settles on chain.' })]);
    try {
      const res = await fetch(`${CFG.judgeApi}/api/judge`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: String(r.jobId) }),
      });
      const out = await res.json().catch(() => ({}));
      const said = out.result === 'judged' ? `Ruled: ${out.pass ? 'PASS' : 'REJECT'} (score ${out.score}). Re-checking it now…`
        : out.result === 'already-judged' ? 'Already ruled. Re-checking it now…'
          : `The judge answered: ${out.result || 'error'}${out.reason ? `, ${out.reason}` : out.error ? `, ${out.error}` : ''}.`;
      set(status, [el('span', { text: said })]);
      if (out.result === 'judged' || out.result === 'already-judged') setTimeout(run, 1500);
      else btn.disabled = false;
    } catch (e) {
      set(status, [el('span', { text: `Could not reach the judge: ${e.message}` })]);
      btn.disabled = false;
    }
  });
  set($('#result'), [el('div', { class: 'verdictbox' }, [
    el('div', { class: 'row', style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('div', { class: 'k', text: `job ${r.jobId} · status ${r.job.status}` }),
        el('div', { class: 'note', text: `budget ${usdc(r.job.budget)} USDC · evaluator is Judge Protocol` }),
      ]),
      el('div', { style: 'text-align:right' }, [
        el('div', { class: 'big', style: `color:${p.color}`, text: p.headline }),
        el('div', { class: 'note', text: p.note }),
      ]),
    ]),
    ...askTheJudge(btn, status),
  ])]);
}

// The ask-the-judge button needs a hosted judge on this network; there is none on Arc mainnet yet.
function askTheJudge(btn, status) {
  if (CFG.judgeApi) {
    return [
      el('p', { class: 'note', style: 'margin-top:12px', text: 'Anyone can ask: the ruling is a pure function of the criteria in the job and the provider\'s commitment, so it does not matter who asks.' }),
      el('div', { class: 'row', style: 'margin-top:8px' }, [btn]),
      status,
    ];
  }
  return [el('p', { class: 'note', style: 'margin-top:12px', text: `There is no hosted judge on ${CFG.label} yet, so this page cannot ask for a ruling here. Check back after the judge rules.` })];
}

function errBox(title, msg) {
  set($('#result'), [el('div', { class: 'verdictbox' }, [
    el('div', { class: 'big', style: 'color:var(--bad)', text: title }),
    el('p', { class: 'note', text: msg }),
  ])]);
}

async function run() {
  const id = parseJobId($('#jobInput').value);
  if (id === null) { errBox('Invalid input', 'Enter a job id as a plain positive number, for example 171925.'); return; }
  $('#goBtn').disabled = true;
  set($('#result'), [el('p', {
    class: 'note',
    text: 'Reading the job, pulling the provider deliverable from calldata, recomputing hashes locally…',
  })]);
  try {
    const r = await verifyJob(id);
    if (r.error) errBox('Cannot verify', r.error);
    else if (r.awaiting) renderAwaiting(r);
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
