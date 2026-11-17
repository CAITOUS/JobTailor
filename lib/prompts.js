// Prompt text and output schemas. The system prompt (instructions + sources) is
// identical for every call, so it is cached once and reused across jobs and answers.

export function buildSystem(settings, sources) {
  const instructions = `You are a job-application writing assistant working for one candidate${settings.profile.fullName ? `, ${settings.profile.fullName}` : ''}. Everything you write is submitted under the candidate's name to real employers, so accuracy outranks polish.

The CANDIDATE SOURCE FILES below are the complete record of the candidate's history. Use only employers, titles, dates, degrees, certifications, tools, and results that appear there. When a source describes an outcome without a number, describe the outcome without inventing one. When a job asks for something the sources don't show, report it as a gap instead of implying the experience.

The candidate's own rules override everything else:
${settings.rules.trim()}

Writing style: plain and specific, active voice, the employer's vocabulary where it truthfully applies. Avoid filler openers ("I am writing to express my interest"), stacked buzzwords, and claims of passion without evidence.`;

  const known = settings.knownAnswers.trim()
    ? `\n\n<known_answers>\nFacts the candidate has confirmed for application questions:\n${settings.knownAnswers.trim()}\n</known_answers>`
    : '';
  const files = sources.length
    ? sources.map((s) => `<source name="${s.name.replace(/"/g, '')}">\n${s.text.trim()}\n</source>`).join('\n\n')
    : '<source name="none">No source files loaded yet.</source>';

  return [
    { type: 'text', text: instructions },
    { type: 'text', text: `<candidate_source_files>\n${files}\n</candidate_source_files>${known}`, cache_control: { type: 'ephemeral' } },
  ];
}

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const JOB_SCHEMA = obj({
  company: str,
  job_title: str,
  fit_score: { type: 'integer' },
  fit_summary: str,
  strengths: strArr,
  gaps: strArr,
  check_before_sending: strArr,
  resume: obj({
    headline: str,
    summary: str,
    skills: { type: 'array', items: obj({ label: str, items: strArr }) },
    experience: { type: 'array', items: obj({ title: str, company: str, location: str, dates: str, bullets: strArr }) },
    education: { type: 'array', items: obj({ credential: str, school: str, dates: str }) },
    certifications: strArr,
  }),
  cover_letter: obj({ greeting: str, paragraphs: strArr, closing: str }),
});

export function jobPrompt(job, extraNotes) {
  return `Tailor an application for this job.

<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'not stated'}
URL: ${job.url}

${job.description}
</job>
${extraNotes ? `\n<candidate_notes_for_this_job>\n${extraNotes}\n</candidate_notes_for_this_job>\n` : ''}
Return:
- company, job_title: as the posting states them.
- fit_score: 0-100, an honest read of how well the sources cover the posting's must-have requirements. 80+ means most must-haves are clearly evidenced; below 50 means significant must-haves are missing.
- fit_summary: two or three sentences a recruiter would agree with.
- strengths: the 3-5 strongest evidenced matches.
- gaps: requirements the sources do not support, most important first. Empty if none.
- check_before_sending: specific things the candidate should verify before submitting — wording that sits closest to the line of what the sources say, dates or titles you condensed, anything you inferred.
- resume: a one-page resume (about 450-650 words) built from the sources, ordered and worded to mirror this posting where truthful. Most recent roles get 3-5 bullets, older roles 1-2. Group skills into 3-4 labeled groups. Dates exactly as the sources give them. Leave education or certifications empty if the sources have none. Do not include the candidate's name or contact details; the document adds them.
- cover_letter: greeting (use the hiring manager's name only if the posting gives it), 3-4 short paragraphs under 320 words total, and a closing line such as "Sincerely,". Don't include the signature name.`;
}

export const ANSWER_SCHEMA = obj({
  answer: str,
  needs_you: { type: 'boolean' },
  needs_you_reason: str,
});

export function answerPrompt({ question, job, pageTitle, pageUrl, length }) {
  const lengths = {
    short: 'One to three sentences.',
    medium: 'About 80-150 words.',
    long: 'About 200-300 words.',
    auto: 'Match the length the question implies; short factual questions get short answers.',
  };
  const jobCtx = job
    ? `<job_context>\n${job.title} at ${job.company}\n${job.description.slice(0, 4000)}\n</job_context>\n`
    : '';
  return `Answer this job-application question in the candidate's own voice (first person).

<question>
${question}
</question>
${jobCtx}<page>${pageTitle || ''} ${pageUrl || ''}</page>

Length: ${lengths[length] || lengths.auto}

If a truthful answer depends on a fact not in the sources or known answers — salary expectations, work authorization or sponsorship, start date, relocation, schedule availability, demographic or EEO questions, references, or any yes/no eligibility — set needs_you to true and say exactly what is needed in needs_you_reason. In that case, write the rest of the answer as a draft with the missing fact in [BRACKETS], or leave answer empty if the whole answer depends on it. Otherwise set needs_you to false and needs_you_reason to "".`;
}
