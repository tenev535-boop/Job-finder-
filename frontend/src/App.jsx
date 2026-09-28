import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------------ */
/*  FirstShift - mobile-first job finder for 16-year-old students            */
/*                                                                          */
/*  Single-file React component.  Talks to the FastAPI backend at /api.     */
/*  Tabs:  🔍 Finder  |  📄 CV & Invite  |  📊 Monitor                       */
/* ------------------------------------------------------------------------ */

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const STORAGE_KEYS = {
  profile: "firstshift.profile.v1",
  applications: "firstshift.applications.v1",
  analyses: "firstshift.analyses.v1",
  assets: "firstshift.assets.v1",
  skipped: "firstshift.skipped.v1",
};

const STATUSES = [
  { id: "applied", label: "Applied / In Review", emoji: "📨", color: "bg-sky-100 text-sky-800 border-sky-200" },
  { id: "interview", label: "Interview Scheduled", emoji: "🗓️", color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  { id: "archived", label: "Archived / Declined", emoji: "🗂️", color: "bg-slate-100 text-slate-600 border-slate-200" },
];

const DEFAULT_PROFILE = {
  name: "",
  age: 16,
  school_year: "Year 11 / Grade 10",
  subjects: [],
  hobbies: [],
  strengths: [],
  achievements: [],
  availability: "After school on weekdays and weekends",
  location: "",
  target_role: "part-time retail or hospitality assistant",
};

const SUGGESTIONS = {
  subjects: ["Maths", "English", "Science", "Art", "PE", "Computing", "History", "Business", "Drama", "Languages"],
  hobbies: ["Football", "Gaming", "Drawing", "Music", "Coding", "Baking", "Volunteering", "Photography", "Reading", "Swimming"],
  strengths: ["Reliable", "Friendly", "Organised", "Quick learner", "Patient", "Creative", "Good with kids", "Calm under pressure"],
  achievements: ["Class representative", "Sports team captain", "School play", "Duke of Edinburgh", "Science fair", "Peer mentor"],
};

/* ----------------------------- utilities -------------------------------- */

function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota - ignore, the UI still works for this session */
  }
}

function usePersistentState(key, fallback) {
  const [value, setValue] = useState(() => loadJSON(key, fallback));
  useEffect(() => {
    saveJSON(key, value);
  }, [key, value]);
  return [value, setValue];
}

async function api(path, { method = "GET", body, params } = {}) {
  const url = new URL(API_BASE + path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
  }
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json();
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(el);
    return ok;
  }
}

function scoreColor(score) {
  if (score >= 75) return { ring: "text-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" };
  if (score >= 50) return { ring: "text-amber-500", text: "text-amber-700", bg: "bg-amber-50" };
  return { ring: "text-rose-500", text: "text-rose-700", bg: "bg-rose-50" };
}

function legalStyle(verdictOrTag) {
  const v = String(verdictOrTag || "").toLowerCase();
  if (v.includes("approved")) return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (v.includes("review")) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-rose-100 text-rose-800 border-rose-200";
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

/* ----------------------------- primitives ------------------------------- */

function Pill({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function ScoreRing({ score, label }) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (s / 100) * circumference;
  const c = scoreColor(s);
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-14 w-14">
        <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
          <circle cx="28" cy="28" r={radius} strokeWidth="6" className="fill-none stroke-slate-200" />
          <circle
            cx="28"
            cy="28"
            r={radius}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className={`fill-none stroke-current transition-all duration-700 ${c.ring}`}
          />
        </svg>
        <div className={`absolute inset-0 flex items-center justify-center text-sm font-bold ${c.text}`}>{s}%</div>
      </div>
      <span className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
    </div>
  );
}

function Button({ children, variant = "primary", className = "", disabled, loading, ...rest }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700",
    secondary: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    ghost: "bg-transparent text-slate-500 hover:bg-slate-100",
    danger: "bg-rose-50 text-rose-700 hover:bg-rose-100",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} disabled={disabled || loading} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner({ className = "h-4 w-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function CopyButton({ text, label = "Copy" , onCopied }) {
  const [state, setState] = useState("idle");
  const handle = async () => {
    if (!text) return;
    const ok = await copyToClipboard(text);
    setState(ok ? "done" : "fail");
    if (ok && onCopied) onCopied();
    setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={!text}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
    >
      {state === "done" ? "✅ Copied" : state === "fail" ? "⚠️ Failed" : `📋 ${label}`}
    </button>
  );
}

function OutputBox({ title, value, placeholder, rows = 6, onChange }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        <CopyButton text={value} />
      </div>
      <textarea
        value={value || ""}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        readOnly={!onChange}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      />
    </div>
  );
}

function TagInput({ label, hint, values, onChange, suggestions = [] }) {
  const [draft, setDraft] = useState("");
  const add = (raw) => {
    const items = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!items.length) return;
    const next = [...values];
    items.forEach((item) => {
      if (!next.some((v) => v.toLowerCase() === item.toLowerCase())) next.push(item);
    });
    onChange(next);
    setDraft("");
  };
  const remove = (item) => onChange(values.filter((v) => v !== item));
  const remaining = suggestions.filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()));
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-slate-800">{label}</label>
      {hint && <p className="mb-2 text-xs text-slate-500">{hint}</p>}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="Type and press Enter"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        />
        <Button type="button" variant="secondary" onClick={() => add(draft)} className="px-3">
          Add
        </Button>
      </div>
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => remove(v)}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
              title="Remove"
            >
              {v} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {remaining.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {remaining.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-full border border-dashed border-slate-300 px-2.5 py-0.5 text-xs text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-slate-800">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      />
    </div>
  );
}

function EmptyState({ emoji, title, body, action }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <div className="text-4xl">{emoji}</div>
      <h3 className="mt-3 text-base font-bold text-slate-800">{title}</h3>
      <p className="mt-1 max-w-xs text-sm text-slate-500">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const tone = toast.type === "error" ? "bg-rose-600" : toast.type === "success" ? "bg-emerald-600" : "bg-slate-800";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <div className={`max-w-md rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ${tone}`}>{toast.message}</div>
    </div>
  );
}

function BottomSheet({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-slate-50 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 rounded-t-3xl">
          <div className="mx-auto absolute left-1/2 top-2 h-1.5 w-10 -translate-x-1/2 rounded-full bg-slate-300" />
          <h2 className="mt-2 text-base font-bold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="mt-2 rounded-full p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4 pb-safe">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------ Finder tab ------------------------------ */

function JobCard({ job, analysis, onDraft, onSkip, drafting }) {
  const [expanded, setExpanded] = useState(false);
  const tag = analysis?.legal?.tag || job.prescreen?.tag;
  const score = analysis ? analysis.match_score : job.quick_match;
  const blocked = analysis ? !analysis.legal.is_safe_for_16 : job.prescreen?.verdict === "blocked";
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill className={legalStyle(tag)}>🛡️ {tag}</Pill>
            <Pill className="bg-slate-100 text-slate-600 border-slate-200">{job.job_type}</Pill>
            {job.source && job.source !== "sample" && <Pill className="bg-slate-100 text-slate-500 border-slate-200">{job.source}</Pill>}
          </div>
          <h3 className="mt-2 text-base font-bold leading-tight text-slate-900">{job.title}</h3>
          <p className="text-sm text-slate-600">
            {job.company} · <span className="text-slate-500">{job.location}</span>
          </p>
        </div>
        <ScoreRing score={score} label={analysis ? "AI match" : "Quick match"} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-slate-50 p-2">
          <dt className="text-slate-400">Pay</dt>
          <dd className="font-semibold text-slate-800">{job.pay || "Not listed"}</dd>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <dt className="text-slate-400">Hours</dt>
          <dd className="font-semibold text-slate-800">{job.hours_per_week ? `${job.hours_per_week} h/week` : "Not listed"}</dd>
        </div>
        <div className="col-span-2 rounded-xl bg-slate-50 p-2">
          <dt className="text-slate-400">Schedule</dt>
          <dd className="font-semibold text-slate-800">{job.schedule || "Not listed"}</dd>
        </div>
      </dl>

      <p className={`mt-3 text-sm text-slate-600 ${expanded ? "" : "line-clamp-2"}`}>{job.description}</p>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 text-xs font-semibold text-indigo-600">
        {expanded ? "Show less" : "Read more"}
      </button>

      {analysis && (
        <div className={`mt-3 rounded-xl p-3 text-xs ${scoreColor(analysis.match_score).bg}`}>
          <p className="font-semibold text-slate-800">Why {analysis.match_score}%</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-600">
            {analysis.match_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {analysis.legal.concerns.length > 0 && (
            <p className="mt-2 text-rose-700">⚠️ {analysis.legal.concerns.join(" · ")}</p>
          )}
        </div>
      )}

      {!analysis && job.prescreen?.reasons?.length > 0 && job.prescreen.verdict !== "approved" && (
        <p className="mt-2 text-xs text-amber-700">⚠️ {job.prescreen.reasons.join(" · ")}</p>
      )}

      {job.tags?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {job.tags.map((t) => (
            <span key={t} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="ghost" onClick={() => onSkip(job)} className="flex-1 border border-slate-200">
          Skip
        </Button>
        {job.url && (
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="inline-flex flex-1 items-center justify-center rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Open ↗
          </a>
        )}
        <Button onClick={() => onDraft(job)} loading={drafting} className="flex-[2]" variant={blocked ? "secondary" : "primary"}>
          {analysis ? "✨ View draft" : "✨ Draft & Apply"}
        </Button>
      </div>
    </article>
  );
}

function FinderTab({ profile, jobs, feedInfo, loading, error, onReload, analyses, onDraft, onSkip, draftingId, skippedCount, onResetSkipped, onScoreAll, scoringAll }) {
  const profileEmpty = !profile.subjects.length && !profile.hobbies.length && !profile.strengths.length;
  return (
    <div className="space-y-3">
      {profileEmpty && (
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
          <strong>Tip:</strong> fill in your subjects and hobbies in the <em>CV &amp; Invite</em> tab to unlock personalised match scores.
        </div>
      )}
      {!loading && !error && !feedInfo.live && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Showing built-in example jobs. No live job board answered. Add an Adzuna key or check the backend's network access to see real listings.
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {loading ? "Finding safe local jobs…" : `${jobs.length} student-safe job${jobs.length === 1 ? "" : "s"}${feedInfo.live ? " · live" : ""}`}
          {skippedCount > 0 && (
            <>
              {" "}
              · {skippedCount} skipped{" "}
              <button type="button" onClick={onResetSkipped} className="font-semibold text-indigo-600">
                undo
              </button>
            </>
          )}
        </p>
        <div className="flex gap-1">
          <Button variant="secondary" onClick={onScoreAll} loading={scoringAll} disabled={!jobs.length || profileEmpty} className="px-3 py-1.5 text-xs">
            ✨ AI-score all
          </Button>
          <Button variant="secondary" onClick={onReload} className="px-3 py-1.5 text-xs" aria-label="Refresh">
            ↻
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          Could not load jobs: {error}.{" "}
          <button type="button" onClick={onReload} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-2xl bg-slate-200" />
          ))}
        </div>
      )}

      {!loading && !error && jobs.length === 0 && (
        <EmptyState
          emoji="🎉"
          title="You're all caught up"
          body="No more jobs to review right now. Undo skipped jobs or check back later."
          action={skippedCount > 0 && <Button variant="secondary" onClick={onResetSkipped}>Show skipped jobs</Button>}
        />
      )}

      {jobs.map((job) => (
        <JobCard key={job.id} job={job} analysis={analyses[job.id]?.analysis} onDraft={onDraft} onSkip={onSkip} drafting={draftingId === job.id} />
      ))}
    </div>
  );
}

function DraftSheet({ entry, job, onClose, onApply, alreadyApplied, onToast }) {
  if (!entry) return null;
  const a = entry.analysis;
  const unsafe = !a.legal.is_safe_for_16;
  return (
    <BottomSheet open={!!entry} onClose={onClose} title={job?.title || "Your draft"}>
      <div className="space-y-3">
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3">
          <ScoreRing score={a.match_score} label="AI match" />
          <div className="min-w-0 flex-1">
            <Pill className={legalStyle(a.legal.tag)}>🛡️ {a.legal.tag}</Pill>
            <p className="mt-1 text-xs text-slate-600">{a.legal.schedule_fit}</p>
            <p className="mt-1 text-xs font-semibold text-slate-800">
              Recommendation:{" "}
              {a.recommendation === "apply" ? "✅ Apply" : a.recommendation === "apply_with_caution" ? "⚠️ Apply with caution" : "⛔ Skip this one"}
            </p>
          </div>
        </div>

        {(unsafe || a.legal.concerns.length > 0) && (
          <div className={`rounded-2xl p-3 text-sm ${unsafe ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-800"}`}>
            <p className="font-bold">{unsafe ? "Not recommended for a 16-year-old" : "Check before you apply"}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {a.legal.concerns.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        <OutputBox title="📄 CV profile" value={a.cv_profile} rows={6} />
        {a.key_skills?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {a.key_skills.map((s) => (
              <Pill key={s} className="bg-indigo-50 text-indigo-700 border-indigo-100">
                {s}
              </Pill>
            ))}
          </div>
        )}
        <OutputBox title="✉️ Message to recruiter" value={a.invitation_message} rows={7} />

        <div className="flex gap-2 pb-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Close
          </Button>
          <Button
            variant={unsafe ? "danger" : "success"}
            className="flex-[2]"
            disabled={alreadyApplied}
            onClick={() => {
              if (unsafe && !window.confirm("This job failed the student-safety check. Track it anyway?")) return;
              onApply();
            }}
          >
            {alreadyApplied ? "✅ Already tracking" : "📨 Mark as applied"}
          </Button>
        </div>
        <p className="pb-3 text-center text-[11px] text-slate-400">
          Copy the message, send it on the job site or by email, then track it in Monitor.{" "}
          <button type="button" className="underline" onClick={() => onToast("Always tell a parent or guardian where you are applying.")}>
            Safety tip
          </button>
        </p>
      </div>
    </BottomSheet>
  );
}

/* ---------------------------- CV & Invite tab --------------------------- */

function CvTab({ profile, setProfile, assets, setAssets, onToast }) {
  const [generating, setGenerating] = useState(false);
  const update = (field) => (value) => setProfile((p) => ({ ...p, [field]: value }));
  const canGenerate = profile.subjects.length + profile.hobbies.length + profile.strengths.length > 0;

  const generate = async () => {
    setGenerating(true);
    try {
      const { target_role, ...studentProfile } = profile;
      const data = await api("/generate-assets", { method: "POST", body: { profile: studentProfile, target_role } });
      setAssets({ ...data.assets, generated_at: data.generated_at, model: data.model });
      onToast("Your CV profile and message are ready", "success");
    } catch (err) {
      onToast(err.message, "error");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-slate-900">About you</h2>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="First name" value={profile.name} onChange={update("name")} placeholder="Sam" />
          <TextField label="Year / grade" value={profile.school_year} onChange={update("school_year")} placeholder="Year 11" />
        </div>
        <TextField label="Town / city" value={profile.location} onChange={update("location")} placeholder="Where you can travel to" />
        <TextField label="When can you work?" value={profile.availability} onChange={update("availability")} placeholder="After school, weekends, holidays" />
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-slate-900">What makes you, you</h2>
        <TagInput label="School subjects" hint="Your favourite or strongest subjects" values={profile.subjects} onChange={update("subjects")} suggestions={SUGGESTIONS.subjects} />
        <TagInput label="Hobbies & activities" hint="Sports, clubs, volunteering, creative stuff" values={profile.hobbies} onChange={update("hobbies")} suggestions={SUGGESTIONS.hobbies} />
        <TagInput label="Personal strengths" hint="How would a teacher or coach describe you?" values={profile.strengths} onChange={update("strengths")} suggestions={SUGGESTIONS.strengths} />
        <TagInput label="Achievements & roles" hint="Awards, responsibilities, things you're proud of" values={profile.achievements} onChange={update("achievements")} suggestions={SUGGESTIONS.achievements} />
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <TextField label="Type of job you're aiming for" value={profile.target_role} onChange={update("target_role")} placeholder="e.g. weekend cafe assistant" />
        <Button onClick={generate} loading={generating} disabled={!canGenerate} className="w-full py-3 text-base">
          {generating ? "Writing your profile…" : "✨ Generate CV & Invite"}
        </Button>
        {!canGenerate && <p className="text-center text-xs text-slate-500">Add at least one subject, hobby or strength to generate.</p>}
      </section>

      <section className="space-y-3">
        <OutputBox
          title="📄 CV profile"
          value={assets?.cv_profile || ""}
          placeholder="Your ATS-friendly CV summary will appear here…"
          rows={7}
          onChange={(v) => setAssets((a) => ({ ...(a || {}), cv_profile: v }))}
        />
        {assets?.key_skills?.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">🔑 Key skills (ATS keywords)</h3>
              <CopyButton text={assets.key_skills.join(", ")} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {assets.key_skills.map((s) => (
                <Pill key={s} className="bg-indigo-50 text-indigo-700 border-indigo-100">
                  {s}
                </Pill>
              ))}
            </div>
          </div>
        )}
        {assets?.cv_sections && (
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">🧾 CV sections</h3>
              <CopyButton
                text={Object.entries(assets.cv_sections)
                  .map(([k, items]) => `${k}\n${items.map((i) => `• ${i}`).join("\n")}`)
                  .join("\n\n")}
              />
            </div>
            <div className="space-y-3">
              {Object.entries(assets.cv_sections).map(([section, items]) => (
                <div key={section}>
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{section}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-slate-700">
                    {items.map((i, idx) => (
                      <li key={idx}>{i}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
        <OutputBox
          title="✉️ Recruiter invitation message"
          value={assets?.invitation_message || ""}
          placeholder="A short, polite 4-sentence message to a recruiter will appear here…"
          rows={8}
          onChange={(v) => setAssets((a) => ({ ...(a || {}), invitation_message: v }))}
        />
        {assets?.generated_at && (
          <p className="text-center text-[11px] text-slate-400">Generated {formatDate(assets.generated_at)} · you can edit the text above before copying</p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------ Monitor tab ----------------------------- */

function MonitorTab({ applications, setApplications, analyses, onToast }) {
  const [filter, setFilter] = useState("all");
  const counts = useMemo(
    () => STATUSES.reduce((acc, s) => ({ ...acc, [s.id]: applications.filter((a) => a.status === s.id).length }), {}),
    [applications]
  );
  const visible = applications.filter((a) => filter === "all" || a.status === filter);

  const setStatus = (id, status) =>
    setApplications((apps) => apps.map((a) => (a.id === id ? { ...a, status, updated_at: new Date().toISOString() } : a)));
  const remove = (id) => {
    if (!window.confirm("Remove this application from your tracker?")) return;
    setApplications((apps) => apps.filter((a) => a.id !== id));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {STATUSES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setFilter(filter === s.id ? "all" : s.id)}
            className={`rounded-2xl border p-3 text-left transition ${filter === s.id ? "ring-2 ring-indigo-400" : ""} ${s.color}`}
          >
            <div className="text-lg">{s.emoji}</div>
            <div className="text-2xl font-extrabold leading-none">{counts[s.id]}</div>
            <div className="mt-1 text-[11px] font-semibold leading-tight">{s.label}</div>
          </button>
        ))}
      </div>

      {applications.length === 0 ? (
        <EmptyState emoji="📭" title="Nothing tracked yet" body="Tap “Draft & Apply” on a job in the Finder, then “Mark as applied” to start your pipeline." />
      ) : visible.length === 0 ? (
        <EmptyState emoji="🔎" title="No applications here" body="Try another status filter." action={<Button variant="secondary" onClick={() => setFilter("all")}>Show all</Button>} />
      ) : (
        <ul className="space-y-3">
          {visible.map((app) => {
            const status = STATUSES.find((s) => s.id === app.status) || STATUSES[0];
            const analysis = analyses[app.job_id]?.analysis || app.analysis;
            return (
              <li key={app.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-bold text-slate-900">{app.title}</h3>
                    <p className="text-sm text-slate-600">
                      {app.company} · <span className="text-slate-400">applied {formatDate(app.applied_at)}</span>
                    </p>
                  </div>
                  {typeof app.match_score === "number" && (
                    <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-bold ${scoreColor(app.match_score).bg} ${scoreColor(app.match_score).text}`}>
                      {app.match_score}%
                    </span>
                  )}
                </div>

                <div className="mt-3">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Status</label>
                  <div className="mt-1 grid grid-cols-3 gap-1">
                    {STATUSES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setStatus(app.id, s.id)}
                        className={`rounded-lg border px-1 py-1.5 text-[11px] font-semibold leading-tight transition ${
                          app.status === s.id ? `${s.color} ring-2 ring-offset-1 ring-indigo-300` : "border-slate-200 bg-white text-slate-500"
                        }`}
                      >
                        {s.emoji} {s.label.split(" / ")[0]}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  value={app.notes || ""}
                  onChange={(e) => setApplications((apps) => apps.map((a) => (a.id === app.id ? { ...a, notes: e.target.value } : a)))}
                  placeholder="Notes: who you spoke to, interview time, what to bring…"
                  rows={2}
                  className="mt-3 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs focus:border-indigo-400 focus:outline-none"
                />

                <div className="mt-3 flex items-center justify-between">
                  <div className="flex gap-1.5">
                    {analysis?.invitation_message && <CopyButton text={analysis.invitation_message} label="Message" onCopied={() => onToast("Message copied", "success")} />}
                    {analysis?.cv_profile && <CopyButton text={analysis.cv_profile} label="CV" onCopied={() => onToast("CV profile copied", "success")} />}
                    {app.url && (
                      <a href={app.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                        Open ↗
                      </a>
                    )}
                  </div>
                  <button type="button" onClick={() => remove(app.id)} className="text-xs font-semibold text-rose-600">
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------- App --------------------------------- */

const TABS = [
  { id: "finder", label: "Finder", emoji: "🔍" },
  { id: "cv", label: "CV & Invite", emoji: "📄" },
  { id: "monitor", label: "Monitor", emoji: "📊" },
];

export default function App() {
  const [tab, setTab] = useState("finder");
  const [profile, setProfile] = usePersistentState(STORAGE_KEYS.profile, DEFAULT_PROFILE);
  const [applications, setApplications] = usePersistentState(STORAGE_KEYS.applications, []);
  const [analyses, setAnalyses] = usePersistentState(STORAGE_KEYS.analyses, {});
  const [assets, setAssets] = usePersistentState(STORAGE_KEYS.assets, null);
  const [skipped, setSkipped] = usePersistentState(STORAGE_KEYS.skipped, []);

  const [jobs, setJobs] = useState([]);
  const [feedInfo, setFeedInfo] = useState({ live: false, sources: {} });
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState("");
  const [draftingId, setDraftingId] = useState(null);
  const [scoringAll, setScoringAll] = useState(false);
  const [sheetJobId, setSheetJobId] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const mainRef = useRef(null);

  const showToast = useCallback((message, type = "info") => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError("");
    try {
      const data = await api("/jobs", {
        params: {
          location: profile.location,
          subjects: profile.subjects.join(","),
          hobbies: profile.hobbies.join(","),
          strengths: profile.strengths.join(","),
        },
      });
      setJobs(data.jobs);
      setFeedInfo({ live: data.live, sources: data.sources });
    } catch (err) {
      setJobsError(err.message);
    } finally {
      setJobsLoading(false);
    }
  }, [profile.location, profile.subjects, profile.hobbies, profile.strengths]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const visibleJobs = useMemo(() => jobs.filter((j) => !skipped.includes(j.id)), [jobs, skipped]);
  const jobById = useCallback((id) => jobs.find((j) => j.id === id), [jobs]);

  const studentProfile = useMemo(() => {
    const { target_role, ...rest } = profile;
    return rest;
  }, [profile]);

  const processJob = useCallback(
    async (job) => {
      const { prescreen, quick_match, ...jobPayload } = job;
      const data = await api("/process-job", { method: "POST", body: { profile: studentProfile, job: jobPayload } });
      setAnalyses((prev) => ({ ...prev, [job.id]: data }));
      return data;
    },
    [studentProfile, setAnalyses]
  );

  const handleDraft = useCallback(
    async (job) => {
      if (analyses[job.id]) {
        setSheetJobId(job.id);
        return;
      }
      setDraftingId(job.id);
      try {
        await processJob(job);
        setSheetJobId(job.id);
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        setDraftingId(null);
      }
    },
    [analyses, processJob, showToast]
  );

  const handleScoreAll = useCallback(async () => {
    const pending = visibleJobs.filter((j) => !analyses[j.id]);
    if (!pending.length) {
      showToast("Every job already has an AI score");
      return;
    }
    setScoringAll(true);
    let failed = 0;
    for (const job of pending) {
      try {
        // Sequential on purpose: keeps rate limits happy and shows scores as they land.
        await processJob(job);
      } catch {
        failed += 1;
      }
    }
    setScoringAll(false);
    showToast(failed ? `Scored ${pending.length - failed} jobs, ${failed} failed` : `Scored ${pending.length} jobs`, failed ? "error" : "success");
  }, [visibleJobs, analyses, processJob, showToast]);

  const handleSkip = useCallback(
    (job) => {
      setSkipped((s) => (s.includes(job.id) ? s : [...s, job.id]));
    },
    [setSkipped]
  );

  const handleApply = useCallback(() => {
    const job = jobById(sheetJobId);
    const entry = analyses[sheetJobId];
    if (!job || !entry) return;
    if (applications.some((a) => a.job_id === job.id)) {
      showToast("Already in your tracker");
      return;
    }
    setApplications((apps) => [
      {
        id: `${job.id}-${Date.now()}`,
        job_id: job.id,
        title: job.title,
        company: job.company,
        match_score: entry.analysis.match_score,
        url: job.url || "",
        status: "applied",
        applied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        notes: "",
        analysis: { cv_profile: entry.analysis.cv_profile, invitation_message: entry.analysis.invitation_message },
      },
      ...apps,
    ]);
    setSheetJobId(null);
    setTab("monitor");
    showToast("Added to your Monitor", "success");
  }, [jobById, sheetJobId, analyses, applications, setApplications, showToast]);

  const sheetJob = sheetJobId ? jobById(sheetJobId) : null;
  const alreadyApplied = sheetJobId ? applications.some((a) => a.job_id === sheetJobId) : false;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col bg-slate-50 shadow-xl">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-gradient-to-r from-indigo-600 to-violet-600 px-4 pb-4 pt-5 text-white shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-extrabold tracking-tight">
                ⚡ FirstShift
              </h1>
              <p className="text-xs text-indigo-100">Safe first jobs for students</p>
            </div>
            <div className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
              {profile.name ? `Hi ${profile.name} 👋` : "16+ safe mode 🛡️"}
            </div>
          </div>
        </header>

        {/* Content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto px-4 pb-28 pt-4">
          {tab === "finder" && (
            <FinderTab
              profile={profile}
              jobs={visibleJobs}
              feedInfo={feedInfo}
              loading={jobsLoading}
              error={jobsError}
              onReload={loadJobs}
              analyses={analyses}
              onDraft={handleDraft}
              onSkip={handleSkip}
              draftingId={draftingId}
              skippedCount={skipped.length}
              onResetSkipped={() => setSkipped([])}
              onScoreAll={handleScoreAll}
              scoringAll={scoringAll}
            />
          )}
          {tab === "cv" && <CvTab profile={profile} setProfile={setProfile} assets={assets} setAssets={setAssets} onToast={showToast} />}
          {tab === "monitor" && <MonitorTab applications={applications} setApplications={setApplications} analyses={analyses} onToast={showToast} />}
        </main>

        {/* Bottom navigation */}
        <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-center" aria-label="Main">
          <div className="pb-safe w-full max-w-md border-t border-slate-200 bg-white/95 backdrop-blur">
            <div className="grid grid-cols-3">
              {TABS.map((t) => {
                const active = tab === t.id;
                const badge = t.id === "monitor" ? applications.filter((a) => a.status !== "archived").length : 0;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold transition ${
                      active ? "text-indigo-600" : "text-slate-400 hover:text-slate-600"
                    }`}
                  >
                    <span className={`text-xl leading-none ${active ? "scale-110" : ""}`}>{t.emoji}</span>
                    <span>{t.label}</span>
                    {badge > 0 && (
                      <span className="absolute right-6 top-1.5 rounded-full bg-indigo-600 px-1.5 text-[10px] font-bold text-white">{badge}</span>
                    )}
                    {active && <span className="absolute inset-x-8 top-0 h-0.5 rounded-b bg-indigo-600" />}
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        <DraftSheet
          entry={sheetJobId ? analyses[sheetJobId] : null}
          job={sheetJob}
          onClose={() => setSheetJobId(null)}
          onApply={handleApply}
          alreadyApplied={alreadyApplied}
          onToast={showToast}
        />
        <Toast toast={toast} />
      </div>
    </div>
  );
}
