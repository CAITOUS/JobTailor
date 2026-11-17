// Functions injected into the job/application page with chrome.scripting.executeScript.
// Each must be fully self-contained: no imports, no outer variables.

// Reads the job posting on the current page.
// If a site changes its layout and extraction breaks, update SITES below.
export function extractJobFromPage() {
  const SITES = [
    {
      match: /(^|\.)indeed\./,
      title: ['[data-testid="jobsearch-JobInfoHeader-title"]', 'h1.jobsearch-JobInfoHeader-title', 'h2.jobsearch-JobInfoHeader-title'],
      company: ['[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]', '[data-testid="jobsearch-CompanyInfoContainer"] a'],
      location: ['[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]', '[data-testid="jobsearch-JobInfoHeader-companyLocation"]'],
      description: ['#jobDescriptionText', '[data-testid="jobsearch-JobComponent-description"]'],
    },
    {
      match: /(^|\.)linkedin\.com$/,
      title: ['.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', '.top-card-layout__title'],
      company: ['.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name', '.topcard__org-name-link'],
      location: ['.job-details-jobs-unified-top-card__primary-description-container .tvm__text', '.topcard__flavor--bullet'],
      description: ['#job-details', '.jobs-description__content', '.jobs-box__html-content', '.show-more-less-html__markup'],
    },
    {
      match: /greenhouse\.io$/,
      title: ['.job__title h1', '.app-title', 'h1.section-header'],
      company: ['.company-name'],
      location: ['.job__location', '.location'],
      description: ['.job__description', '#content'],
    },
    {
      match: /lever\.co$/,
      title: ['.posting-headline h2'],
      company: [],
      location: ['.posting-categories .location', '.posting-category.location'],
      description: ['[data-qa="job-description"]', '.posting-page .section-wrapper.page-full-width'],
    },
    {
      match: /myworkdayjobs\.com$|workday\.com$/,
      title: ['[data-automation-id="jobPostingHeader"]'],
      company: [],
      location: ['[data-automation-id="locations"]'],
      description: ['[data-automation-id="jobPostingDescription"]'],
    },
  ];

  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const first = (sels) => {
    for (const s of sels || []) {
      try {
        const t = text(document.querySelector(s));
        if (t) return t;
      } catch (_) { /* bad selector */ }
    }
    return '';
  };
  const stripHtml = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return text(d) || d.textContent || '';
  };

  // Structured data: most job boards embed a schema.org JobPosting.
  let ld = null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = [].concat(data, data['@graph'] || []);
      const hit = items.find((x) => x && [].concat(x['@type']).includes('JobPosting'));
      if (hit) { ld = hit; break; }
    } catch (_) { /* ignore */ }
  }
  const ldLocation = (() => {
    if (!ld || !ld.jobLocation) return '';
    const loc = [].concat(ld.jobLocation)[0];
    const a = loc && loc.address;
    return a ? [a.addressLocality, a.addressRegion, a.addressCountry].filter((x) => typeof x === 'string').join(', ') : '';
  })();

  const site = SITES.find((s) => s.match.test(location.hostname)) || {};
  let title = first(site.title) || (ld && ld.title) || '';
  let company = first(site.company) || (ld && ld.hiringOrganization && ld.hiringOrganization.name) || '';
  const loc = first(site.location) || ldLocation;
  let description = first(site.description) || (ld && stripHtml(ld.description)) || '';

  if (!title) title = text(document.querySelector('h1')) || document.title;
  if (!company) {
    const og = document.querySelector('meta[property="og:site_name"]');
    company = (og && og.content) || '';
    if (!company && / at /i.test(document.title)) company = document.title.split(/ at /i).pop().split(/[|\-–]/)[0].trim();
  }
  let usedFallback = false;
  if (description.length < 200) {
    usedFallback = true;
    const main = document.querySelector('main, [role="main"], article') || document.body;
    description = text(main);
  }

  return {
    title: title.slice(0, 200),
    company: company.slice(0, 120),
    location: loc.slice(0, 160),
    url: location.href,
    description: description.replace(/\n{3,}/g, '\n\n').slice(0, 24000),
    source: site.match ? location.hostname : 'generic',
    usedFallback,
  };
}

// Fills empty contact fields on an application form. Never submits anything.
export function autofillContactFields(profile) {
  const name = (profile.fullName || '').trim();
  const parts = name.split(/\s+/);
  const values = {
    first: parts[0] || '',
    last: parts.length > 1 ? parts[parts.length - 1] : '',
    full: name,
    email: profile.email || '',
    phone: profile.phone || '',
    linkedin: profile.linkedin || '',
    website: profile.website || '',
    city: profile.location || '',
  };
  const RULES = [
    ['first', /first.?name|given.?name|fname/i],
    ['last', /last.?name|family.?name|surname|lname/i],
    ['email', /e-?mail/i],
    ['phone', /phone|mobile|tel\b/i],
    ['linkedin', /linked.?in/i],
    ['website', /website|portfolio|personal.?site|url/i],
    ['city', /^(city|location|current location|address city)$|city|current.?location/i],
    ['full', /full.?name|^name$|your name|legal name/i],
  ];
  const labelFor = (el) => {
    const bits = [];
    if (el.labels) for (const l of el.labels) bits.push(l.innerText);
    bits.push(el.getAttribute('aria-label') || '', el.placeholder || '', el.name || '', el.id || '', el.getAttribute('autocomplete') || '');
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) bits.push(n.innerText); });
    return bits.join(' | ').trim();
  };
  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const filled = [];
  const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])');
  for (const el of inputs) {
    if (el.disabled || el.readOnly || el.value || el.offsetParent === null) continue;
    const label = labelFor(el);
    if (!label) continue;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    let key = { 'given-name': 'first', 'family-name': 'last', name: 'full', email: 'email', tel: 'phone', url: 'website', 'address-level2': 'city' }[ac];
    if (!key) {
      const rule = RULES.find(([, re]) => re.test(label));
      key = rule && rule[0];
    }
    if (key === 'website' && /linked.?in/i.test(label)) key = 'linkedin';
    if (!key || !values[key]) continue;
    setValue(el, values[key]);
    el.style.outline = '2px solid #7c5cff';
    filled.push(`${label.split('|')[0].trim() || key} → ${key}`);
  }
  return filled;
}

// Inserts text into the focused field, or waits for the next click on a field.
export function insertAnswerIntoPage(answer) {
  const editable = (el) => el && (
    (el instanceof HTMLTextAreaElement) ||
    (el instanceof HTMLInputElement && /^(text|search|url|email|tel|)$/.test(el.type)) ||
    el.isContentEditable
  );
  const put = (el) => {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('insertText', false, answer);
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, answer);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.style.outline = '2px solid #7c5cff';
  };
  if (editable(document.activeElement)) { put(document.activeElement); return 'inserted'; }

  const old = document.getElementById('__jt_banner');
  if (old) old.remove();
  const banner = document.createElement('div');
  banner.id = '__jt_banner';
  banner.textContent = 'Job Tailor: click the field to insert your answer (Esc to cancel)';
  Object.assign(banner.style, {
    position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647,
    background: '#1f1b2e', color: '#fff', padding: '10px 16px', borderRadius: '8px',
    font: '14px system-ui, sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
  });
  document.documentElement.appendChild(banner);
  const cleanup = () => {
    banner.remove();
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onFocus = (e) => { if (editable(e.target)) { cleanup(); put(e.target); } };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('keydown', onKey, true);
  return 'armed';
}
