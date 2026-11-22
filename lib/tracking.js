// Application tracking: stages, follow-up timing and the activity timeline.
// Pure functions only (no storage), so store.js, panel.js and background.js can all share them.

export const STAGES = [
  { id: 'tailored', label: 'Tailored' },
  { id: 'applied', label: 'Applied' },
  { id: 'screening', label: 'Screening' },
  { id: 'interviewing', label: 'Interviewing' },
  { id: 'offer', label: 'Offer' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'no_response', label: 'No response' },
];
// Stages where follow-ups are tracked and flagged.
export const ACTIVE = new Set(['applied', 'screening', 'interviewing', 'offer']);
// Stages that end the application: no more follow-ups.
export const CLOSED = new Set(['accepted', 'rejected', 'withdrawn', 'no_response']);

export const METHODS = [
  { id: 'email', label: 'Email' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'phone', label: 'Phone' },
  { id: 'text', label: 'Text' },
  { id: 'portal', label: 'Portal / ATS' },
  { id: 'video', label: 'Video call' },
  { id: 'in_person', label: 'In person' },
  { id: 'referral', label: 'Referral / intro' },
  { id: 'other', label: 'Other' },
];

// next: days until the next follow-up (null = leave as is, 'default' = the Options setting, 'clear' = none).
// stage: stage to suggest after logging this activity (null = keep the current stage).
export const ACTIVITY_TYPES = [
  { id: 'follow_up', label: 'Follow-up sent', method: 'email', next: 'default', action: (n) => `Follow-up #${n + 1}` },
  { id: 'response', label: 'They responded', method: 'email', next: 2, action: () => 'Reply / schedule next step' },
  { id: 'screen', label: 'Recruiter / phone screen', method: 'phone', next: 1, action: () => 'Send thank-you note', stage: 'screening' },
  { id: 'interview', label: 'Interview', method: 'video', next: 1, action: () => 'Send thank-you note', stage: 'interviewing' },
  { id: 'thank_you', label: 'Thank-you sent', method: 'email', next: 7, action: () => 'Check in on decision' },
  { id: 'offer', label: 'Offer received', method: 'email', next: 2, action: () => 'Respond to offer', stage: 'offer' },
  { id: 'rejection', label: 'Rejection', method: 'email', next: 'clear', action: () => '', stage: 'rejected' },
  { id: 'note', label: 'Note', method: '', next: null, action: null },
];
// Logged automatically when the stage changes; not offered in the activity form.
export const STAGE_CHANGE = { id: 'stage', label: 'Stage change' };

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
export const STAGE_BY_ID = byId(STAGES);
export const METHOD_BY_ID = byId(METHODS);
export const TYPE_BY_ID = { ...byId(ACTIVITY_TYPES), stage: STAGE_CHANGE };

export const stageLabel = (id) => (STAGE_BY_ID[id] || { label: id || '' }).label;
export const methodLabel = (id) => (METHOD_BY_ID[id] || { label: id || '' }).label;
export const typeLabel = (id) => (TYPE_BY_ID[id] || { label: id || '' }).label;

// ---------- dates (follow-up dates are local calendar days, "YYYY-MM-DD") ----------
const pad = (n) => String(n).padStart(2, '0');
export function localDate(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
export const todayStr = () => localDate();
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
// A date picked in the form becomes a timestamp: now if it's today, otherwise noon that day.
export function dateToIso(dateStr) {
  return dateStr === todayStr() ? new Date().toISOString() : new Date(`${dateStr}T12:00:00`).toISOString();
}
export function shortDate(dateOrIso) {
  if (!dateOrIso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? new Date(`${dateOrIso}T12:00:00`) : new Date(dateOrIso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function daysAgo(iso) {
  const days = Math.round((new Date(`${todayStr()}T12:00:00`) - new Date(`${localDate(iso)}T12:00:00`)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
}

// ---------- entries ----------
// Fills fields added in data version 3 so older log entries work unchanged.
export function normalizeEntry(e, followUpDays = 10) {
  const out = {
    activities: [],
    nextFollowUpAt: '',
    nextAction: '',
    contact: { name: '', role: '', info: '' },
    payRange: '',
    notes: '',
    ...e,
  };
  out.contact = { name: '', role: '', info: '', ...(e.contact || {}) };
  if (!Array.isArray(out.activities)) out.activities = [];
  if (e.nextFollowUpAt === undefined && ACTIVE.has(out.status) && out.appliedAt) {
    out.nextFollowUpAt = addDays(localDate(out.appliedAt), followUpDays);
    if (!out.nextAction) out.nextAction = 'Follow-up #1';
  }
  return out;
}

export const followUpCount = (e) => (e.activities || []).filter((a) => a.type === 'follow_up').length;

export function lastContact(e) {
  const acts = (e.activities || []).filter((a) => a.type !== 'stage' && a.type !== 'note');
  return acts.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}

export function isDue(e) {
  return ACTIVE.has(e.status) && !!e.nextFollowUpAt && e.nextFollowUpAt <= todayStr();
}

export function lastTouched(e) {
  const times = [e.createdAt, e.appliedAt, ...(e.activities || []).map((a) => a.at)].filter(Boolean);
  return times.sort().pop() || '';
}

// Suggested next follow-up date and next action after logging an activity of this type.
export function activityDefaults(typeId, dateStr, entry, followUpDays) {
  const t = TYPE_BY_ID[typeId];
  if (!t || t.next === null) return { next: entry.nextFollowUpAt || '', action: entry.nextAction || '' };
  if (t.next === 'clear') return { next: '', action: '' };
  const days = t.next === 'default' ? followUpDays : t.next;
  const n = followUpCount(entry) + (typeId === 'follow_up' ? 1 : 0);
  return { next: addDays(dateStr, days), action: t.action(n) };
}

// Patch to apply when an entry moves to a new stage.
export function stagePatch(entry, newStage, followUpDays) {
  const patch = { status: newStage };
  if (newStage === 'applied' && !entry.appliedAt) patch.appliedAt = new Date().toISOString();
  if (CLOSED.has(newStage)) {
    patch.nextFollowUpAt = '';
    patch.nextAction = '';
  } else if (ACTIVE.has(newStage) && !entry.nextFollowUpAt) {
    patch.nextFollowUpAt = addDays(todayStr(), followUpDays);
    patch.nextAction = newStage === 'applied' ? 'Follow-up #1' : 'Check in';
  }
  return patch;
}

export function newActivity(fields) {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), method: '', contact: '', note: '', ...fields };
}

export function activityLine(a) {
  const bits = [localDate(a.at), typeLabel(a.type)];
  if (a.method) bits.push(`via ${methodLabel(a.method)}`);
  if (a.contact) bits.push(`with ${a.contact}`);
  if (a.stageFrom && a.stage && a.stageFrom !== a.stage) bits.push(`(${stageLabel(a.stageFrom)} → ${stageLabel(a.stage)})`);
  return `${bits.join(' ')}${a.note ? `: ${a.note}` : ''}`;
}
