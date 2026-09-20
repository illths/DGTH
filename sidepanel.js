'use strict';

const $ = id => document.getElementById(id);
const DEFAULT_MODEL = 'claude-sonnet-5';

/* ---------- storage helpers ---------- */
async function getStored(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] === undefined ? fallback : o[key];
}
const setStored = (key, value) => chrome.storage.local.set({ [key]: value });

/* ---------- DOM helpers (all text goes through textContent) ---------- */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function setStatus(msg, isError) {
  $('results').replaceChildren(el('p', 'status-msg' + (isError ? ' error' : ''), msg));
}
function friendlyError(e) {
  return e instanceof TypeError
    ? 'Could not reach the server (you may be offline, or a filter is blocking it)'
    : e.message;
}

/* ---------- tabs ---------- */
const TABS = ['ask', 'notes', 'cards', 'timer'];
function showTab(name) {
  TABS.forEach(t => {
    $('tab-' + t).hidden = t !== name;
    document.querySelector(`[data-tab="${t}"]`).setAttribute('aria-selected', String(t === name));
  });
}
document.querySelectorAll('[data-tab]').forEach(b =>
  b.addEventListener('click', () => showTab(b.dataset.tab)));

/* =====================================================================
   ASK
   ===================================================================== */

/* ----- settings ----- */
async function refreshAiControls() {
  const key = await getStored('apiKey', '');
  const on = await getStored('aiOn', true);
  const toggle = $('aiToggle');
  toggle.disabled = !key;
  toggle.checked = !!key && on;
  $('aiToggleLabel').classList.toggle('disabled', !key);
  $('aiToggleText').textContent = key ? 'AI answers' : 'AI answers (add an API key in settings)';
}
$('saveSettings').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (key) await setStored('apiKey', key);
  await setStored('model', $('modelName').value.trim() || DEFAULT_MODEL);
  $('apiKey').value = '';
  await refreshAiControls();
  setStatus(key ? 'Settings saved. AI answers are available.' : 'Model saved.');
});
$('clearSettings').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  await refreshAiControls();
  setStatus('API key removed.');
});
$('aiToggle').addEventListener('change', async () => {
  await setStored('aiOn', $('aiToggle').checked);
});

/* ----- calculator (no eval) ----- */
function looksLikeMath(s) {
  return /^[\d\s.+\-*/^%()]+$/.test(s) && /\d/.test(s) && /[+\-*/^%]/.test(s.replace(/^\s*-/, ''));
}
function evaluateMath(src) {
  const tokens = src.match(/\d*\.?\d+|[+\-*/^%()]/g);
  if (!tokens || tokens.join('') !== src.replace(/\s+/g, '')) throw new Error('Bad expression');
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next(); const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary() {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek() === '^') { next(); return Math.pow(base, unary()); }
    return base;
  }
  function atom() {
    const t = next();
    if (t === '(') { const v = expr(); if (next() !== ')') throw new Error('Missing )'); return v; }
    const n = parseFloat(t);
    if (Number.isNaN(n)) throw new Error('Unexpected token');
    return n;
  }
  const result = expr();
  if (pos !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid');
  return result;
}

/* ----- question parsing + Wikidata direct answers ----- */
const VERB_PROPS = {
  wrote: ['P50', 'P170'], write: ['P50', 'P170'], authored: ['P50'],
  directed: ['P57'], painted: ['P170'], composed: ['P86', 'P50'],
  invented: ['P61', 'P170', 'P112'], discovered: ['P61', 'P170'],
  founded: ['P112', 'P170'], started: ['P112', 'P170'], established: ['P112'],
  developed: ['P178', 'P287', 'P170'], programmed: ['P178', 'P943'],
  designed: ['P287', 'P84', 'P170'], built: ['P84', 'P170', 'P176', 'P112'],
  sang: ['P175'],
  made: ['P170', 'P50', 'P178', 'P61', 'P112', 'P57', 'P86', 'P287', 'P176'],
  make: ['P170', 'P50', 'P178', 'P61', 'P112', 'P57', 'P86', 'P287', 'P176'],
  created: ['P170', 'P50', 'P178', 'P61', 'P112', 'P57', 'P86', 'P287'],
  create: ['P170', 'P50', 'P178', 'P61', 'P112', 'P57', 'P86', 'P287'],
  produced: ['P162', 'P176', 'P170']
};
const NOUN_TO_VERB = {
  author: 'wrote', writer: 'wrote', creator: 'created', inventor: 'invented',
  founder: 'founded', director: 'directed', composer: 'composed',
  developer: 'developed', designer: 'designed', architect: 'designed', painter: 'painted'
};
const PROP_LABELS = {
  P50: 'Author', P170: 'Creator', P57: 'Director', P86: 'Composer',
  P61: 'Discoverer or inventor', P112: 'Founder', P178: 'Developer',
  P287: 'Designer', P84: 'Architect', P176: 'Manufacturer', P175: 'Performer',
  P943: 'Programmer', P162: 'Producer', P36: 'Capital',
  P569: 'Born', P570: 'Died', P571: 'Created or founded', P575: 'Discovered', P577: 'First published or released'
};
const DATE_WORDS = {
  born: ['P569'], died: ['P570'], founded: ['P571'], created: ['P571', 'P577'],
  invented: ['P571'], built: ['P571'], written: ['P577', 'P571'],
  published: ['P577'], released: ['P577'], discovered: ['P575'], started: ['P571']
};

function parseQuestion(q) {
  const text = q.trim().replace(/[?!.\s]+$/g, '');
  let m = text.match(/^who\s+(?:was\s+|is\s+)?(?:the\s+)?(?:person\s+)?(?:who\s+|that\s+)?(wrote|write|authored|directed|painted|composed|invented|discovered|founded|started|established|developed|programmed|designed|built|made|make|created|create|produced|sang)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i);
  if (m) return { topic: m[2].trim(), direct: { type: 'entity', props: VERB_PROPS[m[1].toLowerCase()], subject: m[2].trim() } };

  m = text.match(/^who\s+(?:is|was)\s+the\s+(author|writer|creator|inventor|founder|director|composer|developer|designer|architect|painter)\s+of\s+(.+)$/i);
  if (m) return { topic: m[2].trim(), direct: { type: 'entity', props: VERB_PROPS[NOUN_TO_VERB[m[1].toLowerCase()]], subject: m[2].trim() } };

  m = text.match(/^what(?:'s|\s+is)\s+the\s+capital\s+(?:city\s+)?of\s+(?:the\s+)?(.+)$/i);
  if (m) return { topic: m[1].trim(), direct: { type: 'entity', props: ['P36'], subject: m[1].trim() } };

  m = text.match(/^when\s+(?:was|were|is)\s+(?:the\s+)?(.+?)\s+(born|founded|created|invented|built|written|published|released|discovered|started)$/i);
  if (m) return { topic: m[1].trim(), direct: { type: 'date', props: DATE_WORDS[m[2].toLowerCase()], subject: m[1].trim() } };

  m = text.match(/^when\s+did\s+(?:the\s+)?(.+?)\s+die$/i);
  if (m) return { topic: m[1].trim(), direct: { type: 'date', props: ['P570'], subject: m[1].trim() } };

  const topic = text
    .replace(/^(what|who|where|when|why|how)\s+(is|are|was|were|does|do|did)\s+(a|an|the)?\s*/i, '')
    .replace(/^(tell me about|explain|define|describe|meaning of)\s+(a|an|the)?\s*/i, '')
    .trim() || text;
  return { topic, direct: null };
}

async function wikidataApi(params) {
  const res = await fetch('https://www.wikidata.org/w/api.php?format=json&origin=*&' + new URLSearchParams(params));
  if (!res.ok) throw new Error('Wikidata request failed (' + res.status + ')');
  return res.json();
}
function formatWikidataTime(value) {
  const m = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(value.time);
  if (!m) return value.time;
  const year = parseInt(m[2], 10);
  if (m[1] === '-') return year + ' BCE';
  if (value.precision <= 9) return String(year);
  const d = new Date(Date.UTC(year, parseInt(m[3], 10) - 1, parseInt(m[4], 10)));
  const opts = value.precision === 10
    ? { year: 'numeric', month: 'long', timeZone: 'UTC' }
    : { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  return d.toLocaleDateString('en-US', opts);
}
async function wikidataAnswer(direct) {
  const found = await wikidataApi({ action: 'wbsearchentities', search: direct.subject, language: 'en', limit: '3', type: 'item' });
  for (const cand of found.search || []) {
    const data = await wikidataApi({ action: 'wbgetentities', ids: cand.id, props: 'claims|labels|descriptions', languages: 'en' });
    const entity = data.entities[cand.id];
    const subject = (entity.labels.en && entity.labels.en.value) || cand.label;
    const description = entity.descriptions.en ? entity.descriptions.en.value : '';
    for (const prop of direct.props || []) {
      const claims = (entity.claims && entity.claims[prop]) || [];
      if (!claims.length) continue;
      let answers = [];
      if (direct.type === 'date') {
        answers = claims.map(c => c.mainsnak.datavalue && c.mainsnak.datavalue.value)
          .filter(v => v && v.time).slice(0, 1).map(formatWikidataTime);
      } else {
        const ids = claims.map(c => c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)
          .filter(Boolean).slice(0, 6);
        if (ids.length) {
          const labels = await wikidataApi({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en' });
          answers = ids.map(id => labels.entities[id] && labels.entities[id].labels.en && labels.entities[id].labels.en.value).filter(Boolean);
        }
      }
      if (answers.length) {
        return { answer: answers.join(', '), label: PROP_LABELS[prop] || 'Answer', subject, description, isDate: direct.type === 'date' };
      }
    }
  }
  return null;
}

/* ----- Wikipedia + dictionary ----- */
async function searchWikipedia(query) {
  const res = await fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=4&srsearch=' + encodeURIComponent(query));
  if (!res.ok) throw new Error('Wikipedia search failed (' + res.status + ')');
  const hits = ((await res.json()).query || {}).search || [];
  if (!hits.length) return null;
  const sum = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hits[0].title.replace(/ /g, '_')));
  if (!sum.ok) throw new Error('Wikipedia summary failed (' + sum.status + ')');
  return { summary: await sum.json(), others: hits.slice(1) };
}
async function lookupWord(word) {
  const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase()));
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

/* ----- optional AI answers (user's own key) ----- */
async function askAI(question) {
  const key = await getStored('apiKey', '');
  const model = await getStored('model', DEFAULT_MODEL);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model, max_tokens: 1000,
      system: 'You are the answer engine inside a student study panel. Explain clearly and concisely in plain text with no markdown headings, so the student understands the idea and not just the answer. If you are unsure or the question depends on recent events, say so.',
      messages: [{ role: 'user', content: question }]
    })
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error.message; } catch (e) { /* ignore */ }
    throw new Error('AI request failed (' + res.status + ')' + (detail ? ': ' + detail : ''));
  }
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/* ----- result cards ----- */
async function addToNotes(text) {
  const notes = await getStored('notes', '');
  const next = (notes ? notes.replace(/\s+$/, '') + '\n\n' : '') + text;
  await setStored('notes', next);
  $('notesArea').value = next;
}
function notesButton(text) {
  const b = el('button', null, 'Add to notes');
  b.type = 'button';
  b.addEventListener('click', async () => { await addToNotes(text); b.textContent = 'Added'; b.disabled = true; });
  return b;
}
function card(title, source, body, notesText) {
  const item = el('div', 'result-item');
  item.appendChild(el('div', 'result-title', title));
  if (source) item.appendChild(el('p', 'result-source', source));
  if (body) item.appendChild(el('p', 'result-snippet', body));
  if (notesText) {
    const actions = el('div', 'item-actions');
    actions.appendChild(notesButton(notesText));
    item.appendChild(actions);
  }
  return item;
}
function quickAnswerCard(a) {
  const item = el('div', 'result-item');
  item.appendChild(el('div', 'result-title', 'Quick answer'));
  item.appendChild(el('p', 'quick-answer', a.answer));
  const detail = (a.isDate ? a.label + ': ' + a.subject : a.label + ' of ' + a.subject)
    + (a.description ? ' (' + a.description + ')' : '') + '. Source: Wikidata';
  item.appendChild(el('p', 'result-source', detail));
  const actions = el('div', 'item-actions');
  actions.appendChild(notesButton(a.answer + ' (' + (a.isDate ? a.label + ': ' : a.label + ' of ') + a.subject + ')'));
  item.appendChild(actions);
  return item;
}
function wordCard(entry) {
  const item = el('div', 'result-item');
  item.appendChild(el('div', 'result-title', entry.word));
  item.appendChild(el('p', 'result-source', 'Dictionary'));
  const ul = el('ul', 'def-list');
  const lines = [];
  (entry.meanings || []).slice(0, 3).forEach(m => {
    const d = m.definitions && m.definitions[0];
    if (d) { lines.push(m.partOfSpeech + ': ' + d.definition); }
  });
  lines.forEach(t => ul.appendChild(el('li', null, t)));
  item.appendChild(ul);
  const actions = el('div', 'item-actions');
  actions.appendChild(notesButton(entry.word + '\n' + lines.join('\n')));
  item.appendChild(actions);
  return item;
}
function wikiCard(r) {
  const s = r.summary;
  const item = el('div', 'result-item');
  item.appendChild(el('div', 'result-title', s.title));
  item.appendChild(el('p', 'result-source', 'Wikipedia'));
  if (s.thumbnail && s.thumbnail.source) {
    const img = el('img', 'thumb');
    img.src = s.thumbnail.source; img.alt = s.title;
    item.appendChild(img);
  }
  item.appendChild(el('p', 'result-snippet', s.extract || 'No summary available for this page.'));
  const actions = el('div', 'item-actions');
  actions.appendChild(notesButton(s.title + '\n' + (s.extract || '')));
  const page = s.content_urls && s.content_urls.desktop && s.content_urls.desktop.page;
  if (page) {
    const a = el('a', null, 'Full article');
    a.href = page; a.target = '_blank'; a.rel = 'noopener noreferrer';
    actions.appendChild(a);
  }
  r.others.forEach(o => {
    const a = el('a', null, o.title);
    a.href = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(o.title.replace(/ /g, '_'));
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    actions.appendChild(a);
  });
  item.appendChild(actions);
  return item;
}

/* ----- main flow ----- */
let searchToken = 0;
async function ask(raw) {
  raw = raw.trim();
  if (!raw) { setStatus('Please enter a search term.', true); return; }
  const token = ++searchToken;
  setStatus('Searching...');

  if (looksLikeMath(raw)) {
    try {
      const value = evaluateMath(raw);
      const item = card('Calculator', null, 'Result for ' + raw);
      item.appendChild(el('p', 'math-result', '= ' + value));
      $('results').replaceChildren(item);
      return;
    } catch (e) { /* not valid math, keep going */ }
  }

  const parsed = parseQuestion(raw);
  const useAI = $('aiToggle').checked && !$('aiToggle').disabled;
  const results = [];
  const errors = new Set();
  const add = (order, node) => results.push({ order, node });
  const fail = e => errors.add(friendlyError(e));
  const jobs = [];

  if (parsed.direct) jobs.push(wikidataAnswer(parsed.direct).then(a => { if (a) add(-1, quickAnswerCard(a)); }).catch(fail));
  if (useAI) jobs.push(askAI(raw).then(t => add(0, card('AI answer', 'Generated by an AI model. Double-check important facts.', t, t))).catch(fail));
  if (/^[A-Za-z][A-Za-z'-]{1,30}$/.test(raw)) jobs.push(lookupWord(raw).then(w => { if (w) add(1, wordCard(w)); }).catch(() => {}));
  jobs.push(searchWikipedia(parsed.topic).then(r => { if (r) add(2, wikiCard(r)); }).catch(fail));

  await Promise.all(jobs);
  if (token !== searchToken) return;

  results.sort((a, b) => a.order - b.order);
  const box = $('results');
  box.replaceChildren();
  if (!results.length) {
    setStatus(errors.size ? 'Could not fetch answers: ' + [...errors].join(' | ') : 'No results found. Try different keywords.', errors.size > 0);
    return;
  }
  results.forEach(r => box.appendChild(r.node));
  if (errors.size) box.appendChild(el('p', 'result-source', 'Some sources failed: ' + [...errors].join(' | ')));
}
$('askForm').addEventListener('submit', e => { e.preventDefault(); ask($('queryInput').value); });

/* ----- right-click lookup from any page ----- */
let lastPending = 0;
function consumePending(p) {
  if (!p || p.t <= lastPending || Date.now() - p.t > 30000) return;
  lastPending = p.t;
  showTab('ask');
  $('queryInput').value = p.text;
  ask(p.text);
}
chrome.storage.session.get('pendingQuery').then(o => consumePending(o.pendingQuery));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingQuery) consumePending(changes.pendingQuery.newValue);
});

/* =====================================================================
   NOTES
   ===================================================================== */
let notesTimer;
$('notesArea').addEventListener('input', () => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    await setStored('notes', $('notesArea').value);
    $('notesStatus').textContent = 'Saved';
  }, 400);
});
$('copyNotes').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('notesArea').value); $('notesStatus').textContent = 'Copied to clipboard'; }
  catch (e) { $('notesStatus').textContent = 'Copy failed. Select the text and copy it manually.'; }
});
$('downloadNotes').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([$('notesArea').value], { type: 'text/plain' }));
  const a = el('a'); a.href = url; a.download = 'notes.txt'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('clearNotes').addEventListener('click', async () => {
  if (!$('notesArea').value || !confirm('Delete all notes? This cannot be undone.')) return;
  $('notesArea').value = '';
  await setStored('notes', '');
  $('notesStatus').textContent = 'Notes cleared';
});

/* =====================================================================
   FLASHCARDS
   ===================================================================== */
let cards = [];
let cardIdx = 0;
let showBack = false;

function renderCard() {
  const view = $('cardView');
  view.replaceChildren();
  $('cardControls').hidden = !cards.length;
  if (!cards.length) {
    view.appendChild(el('p', 'status-msg', 'No cards yet. Add a front and back above.'));
    return;
  }
  cardIdx = Math.min(cardIdx, cards.length - 1);
  const c = cards[cardIdx];
  view.appendChild(el('p', 'card-count', 'Card ' + (cardIdx + 1) + ' of ' + cards.length + (showBack ? ' (back)' : ' (front)')));
  view.appendChild(el('div', 'flash' + (showBack ? ' back' : ''), showBack ? c.a : c.q));
}
$('cardForm').addEventListener('submit', async e => {
  e.preventDefault();
  cards.push({ q: $('cardQ').value.trim(), a: $('cardA').value.trim() });
  await setStored('cards', cards);
  $('cardQ').value = ''; $('cardA').value = '';
  cardIdx = cards.length - 1; showBack = false;
  renderCard();
  $('cardQ').focus();
});
$('cardFlip').addEventListener('click', () => { showBack = !showBack; renderCard(); });
$('cardNext').addEventListener('click', () => { cardIdx = (cardIdx + 1) % cards.length; showBack = false; renderCard(); });
$('cardPrev').addEventListener('click', () => { cardIdx = (cardIdx - 1 + cards.length) % cards.length; showBack = false; renderCard(); });
$('cardShuffle').addEventListener('click', async () => {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  cardIdx = 0; showBack = false;
  await setStored('cards', cards);
  renderCard();
});
$('cardDelete').addEventListener('click', async () => {
  cards.splice(cardIdx, 1);
  showBack = false;
  await setStored('cards', cards);
  renderCard();
});

/* =====================================================================
   TIMER
   ===================================================================== */
let timerEnd = 0;
let timerLabel = '';
let timerNote = '';

function renderTimer() {
  const left = Math.max(0, timerEnd - Date.now());
  if (timerEnd && left === 0) {
    timerNote = timerLabel + ' finished';
    timerEnd = 0;
    setStored('timer', null);
  }
  if (!timerEnd) {
    $('timerDisplay').textContent = '--:--';
    $('timerLabel').textContent = timerNote || 'Ready';
    return;
  }
  const s = Math.ceil(left / 1000);
  $('timerDisplay').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  $('timerLabel').textContent = timerLabel;
}
function startTimer(minutes, label) {
  if (!minutes || minutes < 1) return;
  timerEnd = Date.now() + minutes * 60000;
  timerLabel = label; timerNote = '';
  setStored('timer', { endAt: timerEnd, label });
  renderTimer();
}
$('startFocus').addEventListener('click', () => startTimer(25, 'Focus'));
$('startBreak').addEventListener('click', () => startTimer(5, 'Break'));
$('startCustom').addEventListener('click', () => startTimer(parseInt($('customMinutes').value, 10), 'Custom timer'));
$('stopTimer').addEventListener('click', () => { timerEnd = 0; timerNote = ''; setStored('timer', null); renderTimer(); });
setInterval(renderTimer, 500);

/* =====================================================================
   INIT
   ===================================================================== */
(async function init() {
  $('modelName').value = await getStored('model', DEFAULT_MODEL);
  $('notesArea').value = await getStored('notes', '');
  cards = await getStored('cards', []);
  const t = await getStored('timer', null);
  if (t && t.endAt > Date.now()) { timerEnd = t.endAt; timerLabel = t.label; }
  await refreshAiControls();
  renderCard();
  renderTimer();
})();
