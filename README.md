# ⚡ FirstShift — Student Job Finder, CV Maker & Application Monitor

A mobile-first web app that helps **16-year-old high-school students** find a safe first job, write an honest ATS-friendly CV profile, message a recruiter politely, and track every application.

Every job passes two gates before a student sees a "Draft & Apply" button:

1. **Deterministic labour-law pre-screen** (no AI): night shifts, early starts, over-hours, hazardous work, age-restricted environments and full-time roles are blocked or flagged *Needs Review*.
2. **Claude structured analysis**: compatibility score, independent safety/legality verification, a CV profile built from subjects, hobbies and achievements (never invented experience), and a 4-sentence recruiter invitation that acknowledges student status and school hours.

```
┌────────────────────────────┐        ┌──────────────────────────────────────┐
│ frontend/  (React + Vite)  │  /api  │ backend/  (FastAPI + Anthropic SDK)  │
│ src/App.jsx  single file   │ ─────▶ │ main.py                              │
│  🔍 Finder   📄 CV & Invite│        │  GET  /api/health                    │
│  📊 Monitor  (localStorage)│ ◀───── │  GET  /api/jobs        pre-screened  │
│ max-w-md, bottom nav       │  JSON  │  POST /api/process-job  Claude       │
└────────────────────────────┘        │  POST /api/generate-assets Claude    │
                                      └──────────────────────────────────────┘
```

## Repository layout

| Path | What it is |
|---|---|
| `backend/main.py` | FastAPI app, labour-law rules, sample job feed, Claude system prompt, structured-output schemas |
| `backend/requirements.txt` | Python dependencies |
| `backend/.env.example` | Environment variables (copy to `backend/.env`) |
| `frontend/src/App.jsx` | The entire mobile UI in one React component (Tailwind utility classes) |
| `frontend/src/main.jsx`, `index.html`, `vite.config.js` | Minimal Vite scaffolding; `/api` is proxied to the backend in dev |

## Prerequisites

- Python 3.11+
- Node.js 20+ (22 recommended)
- An Anthropic API key: <https://console.anthropic.com/>

## 1. Run the backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # then paste your ANTHROPIC_API_KEY into .env
uvicorn main:app --reload --port 8000
```

Check it: <http://localhost:8000/api/health> should return `"ai_configured": true`. Interactive docs live at <http://localhost:8000/docs>.

## 2. Run the frontend

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173> in a phone-sized browser window (or on your phone over the same Wi-Fi with `npm run dev -- --host`). Vite proxies `/api/*` to `http://localhost:8000`, so no CORS configuration is needed in development.

## 3. Try the flow

1. **📄 CV & Invite** — add subjects, hobbies, strengths and achievements (tap the suggestion chips), then **Generate CV & Invite**. Copy the CV profile or recruiter message with one tap; both boxes are editable.
2. **🔍 Finder** — jobs are sorted with *16+ Approved* first. Tap **✨ Draft & Apply** on a card to get an AI match score, a safety verdict, a job-specific CV profile and a 4-sentence message. **Skip** hides a job (undo at the top). **AI-score all** scores every visible card.
3. **📊 Monitor** — after **Mark as applied**, move the application between *Applied / In Review → Interview Scheduled → Archived / Declined*, add notes, and re-copy the message.

Profile, analyses and applications persist in the browser's `localStorage`.

## API reference

### `POST /api/process-job`

Request:

```json
{
  "profile": {
    "name": "Alex", "age": 16, "school_year": "Year 11",
    "subjects": ["Maths", "PE"], "hobbies": ["Football"], "strengths": ["Patient"],
    "achievements": ["Team captain"], "availability": "After school and weekends", "location": "Northside"
  },
  "job": {
    "id": "job-004", "title": "Peer Maths Tutor", "company": "BrightPath Tutoring",
    "location": "Online / Downtown", "pay": "$18.00/hr", "schedule": "Flexible after school",
    "hours_per_week": 6, "shift_start": "16:00", "shift_end": "19:00", "job_type": "Part-time",
    "min_age": 16, "description": "Help younger students with maths homework…", "tags": ["maths"]
  }
}
```

Response:

```json
{
  "job_id": "job-004",
  "analysis": {
    "match_score": 84,
    "match_reasons": ["Strong maths overlap", "Evening slots fit school"],
    "legal": { "is_safe_for_16": true, "tag": "16+ Approved", "concerns": [], "schedule_fit": "…" },
    "cv_profile": "…3-5 sentences…",
    "key_skills": ["Maths", "Patience", "Communication"],
    "invitation_message": "…exactly 4 sentences…",
    "recommendation": "apply"
  },
  "prescreen": { "verdict": "approved", "tag": "16+ Approved", "reasons": ["…"] },
  "model": "claude-opus-5-5",
  "generated_at": "2026-09-28T20:00:00+00:00"
}
```

`POST /api/generate-assets` takes `{ "profile": {...}, "target_role": "…" }` and returns `cv_profile`, `key_skills`, `invitation_message` and `cv_sections`.

`GET /api/jobs?subjects=Maths,PE&hobbies=Football&location=Northside` returns the pre-screened feed with a cheap keyword `quick_match`. Add `include_blocked=true` to see jobs that failed the safety check.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the two AI endpoints |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Any current Claude model ID (`claude-3-5-sonnet` was retired in Oct 2025) |
| `CLAUDE_EFFORT` | `medium` | `low` / `medium` / `high` — reasoning depth vs. cost |
| `CLAUDE_MAX_TOKENS` | `4096` | Output cap per call |
| `ALLOWED_ORIGINS` | `http://localhost:5173,…` | CORS origins when the frontend is served from another host |
| `VITE_API_BASE` (frontend) | `/api` | Point the built frontend at a hosted backend |

The AI calls use structured outputs (Pydantic schema enforced by the API), prompt caching on the system prompt, and Anthropic's server-side refusal fallback so a classifier decline is retried on a fallback model automatically.

## Student-safety rules

Rules live in `LABOR_RULES` in `backend/main.py` and are deliberately conservative (no work after 22:00 or before 07:00, max 20 h/week in term, hazardous-keyword block list, age gates). **They are not legal advice** — check the youth-employment rules for your country/state and adjust the constants. The deterministic screen can only make an AI verdict stricter, never looser.

## Production notes

- Replace `SAMPLE_JOBS` with a real feed (job-board API, scraper or database) — the pre-screen and scoring work on any `Job` object.
- `npm run build` outputs a static bundle in `frontend/dist/`; serve it from any static host with `VITE_API_BASE` set to your backend URL and that origin added to `ALLOWED_ORIGINS`.
- Run the backend with `uvicorn main:app --host 0.0.0.0 --port 8000` behind HTTPS. Keep the API key on the server only; the browser never talks to Anthropic directly.
