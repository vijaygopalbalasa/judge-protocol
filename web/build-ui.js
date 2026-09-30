// The checklist builder page. Every rule lives in builder.js, which is tested against the judge;
// this file only reads the form, shows the checklist and runs the dry run. Nothing leaves the
// browser (the page's CSP has connect-src 'none'), and text reaches the page through textContent only.

import { buildCriteria, jobDescription, describe, describeCheck, dryRun, BuilderError, FIELD_TYPES } from './builder.js';
import { criteriaHash } from './app.js';
import { el, set } from './ui.js';

const $ = (id) => document.getElementById(id);

const KINDS = [
  { id: 'text', title: 'Written answer', desc: 'An article, a reply, a report' },
  { id: 'records', title: 'List of records', desc: 'A JSON list, like leads or links' },
  { id: 'record', title: 'One record', desc: 'A JSON object, like an API reply' },
  { id: 'file', title: 'Exact file', desc: 'The exact bytes you expect' },
  { id: 'endpoint', title: 'Live web address', desc: 'A page or API that must answer' },
];
const TYPE_LABELS = {
  text: 'Text', url: 'Web address', email: 'Email', 'email-or-url': 'Email or web address',
  number: 'Number', integer: 'Whole number', 'yes-no': 'Yes or no', 'one-of': 'One of a list',
};

const row = (over = {}) => ({ name: '', type: 'text', options: '', required: true, ...over });
const JOB18 = () => ({
  min: '10', max: '10', uniqueField: 'website', uniqueKey: 'domain', noExtra: false,
  fields: [
    row({ name: 'name' }), row({ name: 'website', type: 'url' }), row({ name: 'network', type: 'one-of', options: 'Arc, Base' }),
    row({ name: 'paid_work_evidence', type: 'url' }), row({ name: 'contact', type: 'email-or-url' }),
  ],
});
const EXAMPLES = {
  text: () => ({ minWords: '400', maxWords: '600', terms: 'USDC\nescrow\nArc', wholeWords: true }),
  records: JOB18,
  record: () => ({ noExtra: true, fields: [row({ name: 'price', type: 'number' }), row({ name: 'currency', type: 'one-of', options: 'USD, EUR' }), row({ name: 'note', required: false })] }),
  file: () => ({ sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', note: 'the example is the fingerprint of a file containing just: hello' }),
  endpoint: () => ({ url: 'https://example.com', status: '200', body: 'Example Domain' }),
};
const EXAMPLE_NOTES = {
  text: 'Example: a 400 to 600 word explainer that names USDC, escrow and Arc.',
  records: 'Example: the checklist of ArcBounty job 18, a live 2 USDC bounty on Arc mainnet, rebuilt here to the same criteria hash.',
  record: 'Example: a price quote with a number, a currency from a list, and an optional note.',
  file: 'Example: the exact file whose content is "hello".',
  endpoint: 'Example: a public page that must answer and show a phrase.',
};
const EMPTY = {
  text: () => ({ minWords: '', maxWords: '', terms: '', wholeWords: false }),
  records: () => ({ min: '', max: '', uniqueField: '', uniqueKey: 'value', noExtra: false, fields: [row()] }),
  record: () => ({ noExtra: false, fields: [row()] }),
  file: () => ({ sha256: '', note: '' }),
  endpoint: () => ({ url: '', status: '200', body: '' }),
};

const state = { template: 'records', loaded: 'records' };
for (const k of Object.keys(EMPTY)) state[k] = EMPTY[k]();
state.records = JOB18();
let current = null; // { criteria, text } when the form makes a valid checklist

/* ------------------------------ form values ------------------------------ */
const num = (v) => {
  const t = String(v ?? '').trim();
  if (!t) return undefined;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t; // anything else reaches the builder as text and is refused there
};
const lines = (v) => String(v ?? '').split('\n');
const commaList = (v) => String(v ?? '').split(',').filter((o) => o.trim() !== '');
const fieldsOf = (rows) => rows.map((r) => ({ name: r.name, type: r.type, required: r.required, ...(r.type === 'one-of' && { options: commaList(r.options) }) }));

function answers() {
  const s = state[state.template];
  const common = { passThreshold: num($('passMark').value) };
  switch (state.template) {
    case 'text': return { ...common, minWords: num(s.minWords), maxWords: num(s.maxWords), terms: lines(s.terms), wholeWords: s.wholeWords };
    case 'records': return {
      ...common, count: { min: num(s.min), max: num(s.max) }, fields: fieldsOf(s.fields), noExtraFields: s.noExtra,
      ...(s.uniqueField && { uniqueBy: { field: s.uniqueField, key: s.uniqueKey } }),
    };
    case 'record': return { ...common, fields: fieldsOf(s.fields), noExtraFields: s.noExtra };
    case 'file': return { ...common, sha256: s.sha256 };
    default: return { ...common, url: s.url, expectStatus: num(s.status), bodyIncludes: lines(s.body) };
  }
}

/* ------------------------------- controls -------------------------------- */
let uid = 0;
function labelled(text, control, hint) {
  control.id = control.id || `c${++uid}`;
  const l = el('label', { text });
  l.setAttribute('for', control.id);
  return el('div', {}, [l, control, hint ? el('div', { class: 'note', text: hint, style: 'margin-top:4px' }) : null]);
}
function bindValue(control, s, key, after) {
  control.value = s[key] ?? '';
  control.addEventListener('input', () => { s[key] = control.value; if (after) after(); refresh(); });
  return control;
}
const textInput = (label, s, key, placeholder, hint) => labelled(label, bindValue(el('input', { placeholder }), s, key), hint);
const numberInput = (label, s, key, placeholder) => labelled(label, bindValue(el('input', { placeholder, inputmode: 'numeric' }), s, key));
const textArea = (label, s, key, rows, placeholder, hint) => labelled(label, bindValue(el('textarea', { rows, placeholder }), s, key), hint);
function checkbox(label, s, key) {
  const box = el('input', { type: 'checkbox' });
  box.checked = s[key] === true;
  box.addEventListener('change', () => { s[key] = box.checked; refresh(); });
  return el('label', { class: 'check-line' }, [box, label]);
}
function select(options, value, onChange) {
  const sel = el('select');
  for (const [v, t] of options) { const o = el('option', { text: t }); o.value = v; sel.append(o); }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function fieldsEditor(s, withUnique) {
  const box = el('div', { class: 'fields' });
  const uniqueBox = el('div');
  const drawUnique = () => {
    if (!withUnique) return;
    const names = s.fields.map((f) => f.name.trim()).filter(Boolean);
    if (s.uniqueField && !names.includes(s.uniqueField)) s.uniqueField = '';
    set(uniqueBox, el('div', { class: 'grid2' }, [
      labelled('No two entries may share', select([['', 'no rule'], ...names.map((n) => [n, n])], s.uniqueField, (v) => { s.uniqueField = v; refresh(); })),
      labelled('Compared by', select([['domain', 'the domain of the web address'], ['value', 'the exact value']], s.uniqueKey, (v) => { s.uniqueKey = v; refresh(); })),
    ]));
  };
  const draw = () => {
    const rows = s.fields.map((f, i) => {
      const name = el('input', { placeholder: 'field name' });
      name.value = f.name;
      name.setAttribute('aria-label', `Field ${i + 1} name`);
      name.addEventListener('input', () => { f.name = name.value; drawUnique(); refresh(); });
      const type = select(FIELD_TYPES.map((t) => [t, TYPE_LABELS[t]]), f.type, (v) => { f.type = v; draw(); refresh(); });
      type.setAttribute('aria-label', `Field ${i + 1} type`);
      const opts = el('input', { placeholder: f.type === 'one-of' ? 'options, separated by commas' : '' });
      opts.className = f.type === 'one-of' ? 'opts' : 'opts off';
      opts.value = f.options;
      opts.disabled = f.type !== 'one-of';
      opts.setAttribute('aria-label', `Field ${i + 1} options`);
      opts.addEventListener('input', () => { f.options = opts.value; refresh(); });
      const req = el('input', { type: 'checkbox' });
      req.checked = f.required !== false;
      req.addEventListener('change', () => { f.required = req.checked; refresh(); });
      const remove = el('button', { class: 'x', type: 'button', text: 'Remove' });
      remove.setAttribute('aria-label', `Remove field ${i + 1}`);
      remove.addEventListener('click', () => { s.fields.splice(i, 1); draw(); drawUnique(); refresh(); });
      return el('div', { class: 'field' }, [name, type, opts, el('label', { class: 'req' }, [req, 'required']), remove]);
    });
    const add = el('button', { class: 'ghost', type: 'button', text: 'Add a field' });
    add.addEventListener('click', () => { s.fields.push(row()); draw(); refresh(); });
    const head = el('div', { class: 'field head' }, [el('span', { text: 'Field name' }), el('span', { text: 'Type' }), el('span', { text: 'Options (for "One of a list")' })]);
    head.setAttribute('aria-hidden', 'true');
    set(box, [head, ...rows, el('div', { class: 'row' }, [add, el('span', { class: 'note', text: 'Options match exactly, letter case included: "arc" is not "Arc".' })])]);
  };
  draw();
  drawUnique();
  return [box, uniqueBox];
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const FORMS = {
  text: (s) => [
    el('div', { class: 'grid2' }, [numberInput('Fewest words', s, 'minWords', 'e.g. 400'), numberInput('Most words', s, 'maxWords', 'e.g. 600')]),
    textArea('Words or phrases it must contain, one per line', s, 'terms', 4, 'USDC\nescrow', 'Exact letter case. Leave empty for none.'),
    checkbox('Whole words only (so "Arc" does not count inside "Architecture")', s, 'wholeWords'),
  ],
  records: (s) => [
    el('div', { class: 'grid2' }, [numberInput('Fewest entries', s, 'min', 'e.g. 10'), numberInput('Most entries', s, 'max', 'e.g. 10')]),
    el('div', { class: 'note', text: 'Each entry has these fields:' }),
    ...fieldsEditor(s, true),
    checkbox('Refuse fields not listed here', s, 'noExtra'),
  ],
  record: (s) => [
    el('div', { class: 'note', text: 'The object has these fields:' }),
    ...fieldsEditor(s, false),
    checkbox('Refuse fields not listed here', s, 'noExtra'),
  ],
  file: (s) => {
    const hash = el('input', { placeholder: '64 hex characters' });
    bindValue(hash, s, 'sha256');
    const picked = el('div', { class: 'note', text: s.note || '' });
    const file = el('input', { type: 'file' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      s.sha256 = await sha256Hex(await f.arrayBuffer());
      s.note = `the fingerprint of ${f.name} (${f.size} bytes), computed in your browser`;
      hash.value = s.sha256;
      picked.textContent = s.note;
      refresh();
    });
    return [labelled('Pick the exact file you expect (it stays in your browser)', file), labelled('Or paste its SHA-256 fingerprint', hash), picked];
  },
  endpoint: (s) => [
    textInput('Web address that must answer', s, 'url', 'https://example.com/health'),
    el('div', { class: 'grid2' }, [numberInput('Expected status', s, 'status', '200'), textArea('Text the page must include, one per line', s, 'body', 3, '"ok":true')]),
    el('div', { class: 'banner', text: 'This is the one kind of check nobody can re-run later: the judge probes the address once, when it rules, and records what it saw. Prefer the other kinds when you can.' }),
  ],
};

/* -------------------------------- render --------------------------------- */
function drawTemplates() {
  set($('templates'), KINDS.map((k) => {
    const b = el('button', { class: 'choice', type: 'button' }, [el('span', { class: 't', text: k.title }), el('span', { class: 'd', text: k.desc })]);
    b.setAttribute('aria-pressed', String(state.template === k.id));
    b.addEventListener('click', () => { state.template = k.id; drawAll(); });
    return b;
  }));
}

function drawExample() {
  const t = state.template;
  if (state.loaded === t) {
    const clear = el('button', { class: 'ghost', type: 'button', text: 'Start empty' });
    clear.addEventListener('click', () => { state[t] = EMPTY[t](); state.loaded = null; drawAll(); });
    set($('example'), [el('span', { text: `${EXAMPLE_NOTES[t]} ` }), clear]);
  } else {
    const load = el('button', { class: 'ghost', type: 'button', text: 'Load an example' });
    load.addEventListener('click', () => { state[t] = EXAMPLES[t](); state.loaded = t; drawAll(); });
    set($('example'), load);
  }
}

function drawAll() {
  drawTemplates();
  drawExample();
  set($('form'), FORMS[state.template](state[state.template]));
  set($('result'), []);
  refresh();
}

function refresh() {
  $('formError').textContent = '';
  try {
    const criteria = buildCriteria(state.template, answers());
    current = { criteria, text: jobDescription($('summary').value, criteria) };
  } catch (e) {
    current = null;
    $('formError').textContent = e instanceof BuilderError ? e.message : `Something went wrong: ${e.message}`;
    set($('plain'), el('li', { class: 'note', text: 'Fix the answer above to see the checklist.' }));
    $('out').value = '';
    $('hash').textContent = '';
    $('copy').disabled = true;
    return;
  }
  set($('plain'), describe(current.criteria).map((l) => el('li', { text: l })));
  $('out').value = current.text;
  $('hash').textContent = `criteria hash ${criteriaHash(current.criteria)}: a ruling commits to this, and anyone can recompute it from the text above`;
  $('copy').disabled = false;
  $('copied').textContent = '';
}

async function runTest() {
  if (!current) { set($('result'), el('p', { class: 'error', text: 'Fix the checklist first.' })); return; }
  const file = $('sampleFile').files[0];
  const bytes = file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode($('sample').value);
  const r = await dryRun(current.criteria, bytes);
  const rows = r.results.map((x, i) => el('tr', {}, [
    el('td', { class: `mark ${x.notRun ? 'na' : x.pass ? 'ok' : 'no'}`, text: x.notRun ? '-' : x.pass ? '✓' : '✗' }),
    el('td', { text: describeCheck(current.criteria.checks[i]) }),
    el('td', { class: 'detail', text: x.notRun ? 'only the judge runs this, when it rules' : x.detail }),
  ]));
  const verdict = r.final
    ? el('div', { class: `verdict ${r.pass ? 'ok' : 'no'}`, text: `Score ${r.score} of 100: the judge would rule ${r.pass ? 'PASS' : 'REJECT'} (pass mark ${r.threshold}).` })
    : el('div', { class: 'verdict na', text: 'Not final: this checklist has a live web check, which only the judge runs when it rules.' });
  set($('result'), [
    el('p', { class: 'note', text: `Tested ${file ? `the file ${file.name}` : 'the pasted text'} (${bytes.length} bytes).` }),
    el('div', { class: 'scroll' }, el('table', {}, [el('thead', {}, el('tr', {}, [el('th', { text: '' }), el('th', { text: 'Check' }), el('th', { text: 'What the judge saw' })])), el('tbody', {}, rows)])),
    verdict,
  ]);
}

$('passMark').addEventListener('input', refresh);
$('summary').addEventListener('input', refresh);
$('test').addEventListener('click', runTest);
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('out').value);
    $('copied').textContent = 'Copied.';
  } catch {
    $('out').focus();
    $('out').select();
    $('copied').textContent = 'Selected: press Ctrl+C (or Cmd+C) to copy.';
  }
});
drawAll();
