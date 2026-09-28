"""
Teen Job Finder - FastAPI backend
=================================

Intelligence layer for a mobile-first job search app built for 16-year-old
high-school students.  Every job that reaches a student passes through two
gates:

1. A deterministic labour-law pre-screen (``prescreen_job``) that flags night
   shifts, excessive hours, and hazardous work *before* any model is called.
2. A structured Claude call (``/api/process-job``) that scores compatibility,
   independently verifies the job is safe and legal for a 16-year-old, writes
   an ATS-friendly CV profile, and drafts a 4-sentence recruiter message.

Run locally:
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Literal

import anthropic
import job_sources
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

logger = logging.getLogger("teen-job-finder")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# claude-3-5-sonnet was retired on 2025-10-28; Claude Opus 5.5 is the current
# default.  Override with CLAUDE_MODEL=... if you need a different model.
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")
CLAUDE_EFFORT = os.getenv("CLAUDE_EFFORT", "medium")
MAX_OUTPUT_TOKENS = int(os.getenv("CLAUDE_MAX_TOKENS", "4096"))
JOB_COUNTRY = os.getenv("JOB_COUNTRY", "gb")  # Adzuna country code: gb, us, ca, au, de, fr, ...
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]

# Student-safety rules.  These reflect common US state rules for 16-17 year
# olds (and are stricter than the federal FLSA baseline).  Adjust to your
# jurisdiction - they are deliberately conservative.
LABOR_RULES = {
    "min_age": 16,
    "earliest_start_hour": 7,        # no starts before 7:00 AM
    "latest_end_hour_school_night": 22,  # must finish by 10:00 PM on school nights
    "max_hours_per_week_school": 20,
    "max_hours_per_week_break": 40,
    "max_hours_per_school_day": 4,
    "hazardous_keywords": [
        "forklift", "roofing", "scaffold", "excavat", "demolition", "meat slicer",
        "power saw", "chainsaw", "welding", "explosive", "firearm", "mining",
        "logging", "commercial driving", "delivery driver", "driving required",
        "deep fryer", "industrial", "chemical handling", "pesticide",
        "bartend", "serve alcohol", "casino", "tobacco", "cannabis", "adult",
        "door to door", "door-to-door", "overnight", "graveyard shift",
        "night shift", "24/7", "on call",
    ],
}

# ---------------------------------------------------------------------------
# Pydantic models (request / response contracts)
# ---------------------------------------------------------------------------


class StudentProfile(BaseModel):
    name: str = Field(default="", description="Student's first name (optional)")
    age: int = Field(default=16, ge=14, le=19)
    school_year: str = Field(default="Year 11 / Grade 10", description="Current grade or year")
    subjects: list[str] = Field(default_factory=list, description="Favourite or strongest school subjects")
    hobbies: list[str] = Field(default_factory=list, description="Hobbies, clubs, sports, volunteering")
    strengths: list[str] = Field(default_factory=list, description="Personal strengths / soft skills")
    achievements: list[str] = Field(default_factory=list, description="School achievements, awards, roles")
    availability: str = Field(
        default="After school on weekdays and weekends",
        description="When the student can work",
    )
    location: str = Field(default="", description="Town / city for local matching")


class Job(BaseModel):
    id: str
    title: str
    company: str
    location: str
    pay: str = ""
    schedule: str = ""
    hours_per_week: int | None = None
    shift_start: str | None = Field(default=None, description="24h HH:MM")
    shift_end: str | None = Field(default=None, description="24h HH:MM")
    job_type: str = Field(default="Part-time", description="Part-time / Seasonal / Weekend / Internship")
    min_age: int | None = None
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    posted_at: str = ""
    url: str = Field(default="", description="Link to the original listing")
    source: str = Field(default="sample", description="Which job board it came from")


class PrescreenResult(BaseModel):
    verdict: Literal["approved", "review", "blocked"]
    tag: str
    reasons: list[str]


class JobCard(Job):
    prescreen: PrescreenResult
    quick_match: int = Field(description="Cheap keyword overlap score (0-100), pre-AI")


class ProcessJobRequest(BaseModel):
    profile: StudentProfile
    job: Job


class GenerateAssetsRequest(BaseModel):
    profile: StudentProfile
    target_role: str = Field(default="part-time retail or hospitality assistant")


# --- Structured output schema returned by Claude ---------------------------


class LegalCheck(BaseModel):
    is_safe_for_16: bool = Field(description="True only if the job is safe AND legal for a 16-year-old student")
    tag: str = Field(description="Short badge such as '16+ Approved', 'Needs Review', or 'Not for 16'")
    concerns: list[str] = Field(description="Specific concerns (night hours, hazards, over-hours). Empty if none.")
    schedule_fit: str = Field(description="One sentence on how the shifts fit a school week")


class JobAnalysis(BaseModel):
    match_score: int = Field(ge=0, le=100, description="Compatibility 0-100")
    match_reasons: list[str] = Field(description="2-4 concise reasons for the score")
    legal: LegalCheck
    cv_profile: str = Field(description="ATS-friendly CV summary, 3-5 sentences, first person")
    key_skills: list[str] = Field(description="4-6 ATS keywords drawn from the student's real strengths")
    invitation_message: str = Field(description="Exactly 4 sentences, polite, mentions student status and school schedule")
    recommendation: Literal["apply", "apply_with_caution", "skip"]


class AssetBundle(BaseModel):
    cv_profile: str = Field(description="ATS-friendly CV summary, 3-5 sentences, first person")
    key_skills: list[str] = Field(description="4-6 ATS keywords drawn from the student's real strengths")
    invitation_message: str = Field(description="Exactly 4 sentences, polite, mentions student status and school schedule")
    cv_sections: dict[str, list[str]] = Field(
        description="Bullet points keyed by CV section: 'Education', 'Skills', 'Activities & Achievements'"
    )


class ProcessJobResponse(BaseModel):
    job_id: str
    analysis: JobAnalysis
    prescreen: PrescreenResult
    model: str
    generated_at: str


class GenerateAssetsResponse(BaseModel):
    assets: AssetBundle
    model: str
    generated_at: str


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are the intelligence engine of a job-search app used by 16-year-old high-school students. You act as a careful careers adviser and a youth-employment compliance officer at the same time.

<mission>
Help a student decide whether a specific local job is a good, SAFE fit, and give them polished application assets that honestly reflect who they are: soft skills, school subjects, hobbies, achievements, and motivation. Students have no corporate experience and must never be made to sound like they do.
</mission>

<student_safety_rules>
Treat every job as if the applicant is exactly 16 and attends school full-time. Apply these rules strictly:
1. NO night work: shifts must end by 10:00 PM on school nights and must not start before 7:00 AM.
2. NO hazardous work: no operating power-driven machinery, forklifts, meat slicers, deep fryers, roofing, scaffolding, excavation, demolition, welding, chemical or pesticide handling, mining, logging, or work involving explosives or firearms.
3. NO driving as part of the job, no commercial deliveries by vehicle.
4. NO alcohol, tobacco, cannabis, gambling, or adult-industry environments, and no serving alcohol.
5. NO door-to-door sales, unsupervised cash handling at night, or working alone late.
6. Hours must be compatible with school: at most 20 hours per week during term (40 during breaks), at most 4 hours on a school day, and clearly part-time, weekend, seasonal, or internship.
7. Supervision and a safe, public environment (shops, cafes, libraries, camps, tutoring, sports clubs, community centres) are strong positives.
When information is missing, do NOT assume the job is safe: mark it "Needs Review" and say what must be confirmed.
</student_safety_rules>

<scoring_rubric>
match_score (0-100) blends:
- 40 points: overlap between the job's duties and the student's subjects, hobbies, strengths, achievements.
- 30 points: schedule fit with school hours and the student's stated availability.
- 20 points: safety/legality (a job that fails the safety rules can never score above 30).
- 10 points: growth value for a first job (training, references, transferable skills).
Be honest. A mediocre fit should score 40-60, not 80.
</scoring_rubric>

<cv_profile_rules>
- 3 to 5 sentences, first person, ATS-friendly (plain language, real keywords from the job ad).
- Lead with motivation and reliability; then subjects, hobbies, and achievements as evidence of skills.
- Never invent jobs, employers, certifications, or years of experience.
- No clichés such as "hard-working team player" without a concrete example.
</cv_profile_rules>

<invitation_message_rules>
Write exactly FOUR sentences addressed to the recruiter or hiring manager:
1. Greeting + which role you are applying for and where you saw it.
2. One sentence on who you are: a 16-year-old student and the ONE strength most relevant to this role.
3. Availability: state clearly that you are in school and give the honest windows (after school, weekends, holidays).
4. Polite, confident close asking for a short conversation or trial shift, and thanking them.
Tone: warm, respectful, no slang, no exclamation marks, no emojis. Do not include a signature block.
</invitation_message_rules>

<output_contract>
Return ONLY the structured JSON object requested. Every string must be safe to show directly to a teenager. Never include placeholder text such as "[Your Name]".
</output_contract>"""

ASSETS_SYSTEM_PROMPT = SYSTEM_PROMPT + """

<assets_mode>
You are generating general-purpose application assets, not evaluating a single job. Target the role type the student gives you, keep the same honesty rules, and additionally return cv_sections with 2-4 bullet points each for "Education", "Skills", and "Activities & Achievements". Each bullet is one short line, ATS-friendly, no full stops at the end.
</assets_mode>"""

# ---------------------------------------------------------------------------
# Deterministic pre-screen (no model needed)
# ---------------------------------------------------------------------------


def _parse_minutes(value: str | None) -> int | None:
    """'HH:MM' -> minutes since midnight, or None if missing/unparseable."""
    if not value:
        return None
    match = re.match(r"^(\d{1,2}):(\d{2})$", value.strip())
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def prescreen_job(job: Job) -> PrescreenResult:
    """Rule-based labour-law check that runs before any AI call."""
    reasons: list[str] = []
    blocked = False
    review = False

    if job.min_age is not None and job.min_age > LABOR_RULES["min_age"]:
        blocked = True
        reasons.append(f"Employer requires age {job.min_age}+")

    haystack = " ".join([job.title, job.description, job.schedule, " ".join(job.tags)]).lower()
    hazards = [kw for kw in LABOR_RULES["hazardous_keywords"] if kw in haystack]
    if hazards:
        blocked = True
        reasons.append("Hazardous or restricted work mentioned: " + ", ".join(sorted(set(hazards))))

    start = _parse_minutes(job.shift_start)
    end = _parse_minutes(job.shift_end)
    latest_end = LABOR_RULES["latest_end_hour_school_night"] * 60
    earliest_start = LABOR_RULES["earliest_start_hour"] * 60
    if end is not None and end > latest_end:
        blocked = True
        reasons.append(f"Shift ends after {LABOR_RULES['latest_end_hour_school_night']}:00")
    if start is not None and end is not None and end <= start:
        blocked = True
        reasons.append("Overnight shift (ends after midnight)")
    if start is not None and start < earliest_start:
        blocked = True
        reasons.append(f"Shift starts before {LABOR_RULES['earliest_start_hour']}:00 AM")
    if end is None:
        review = True
        reasons.append("Finish time not listed - confirm shifts end by 10 PM")

    if job.hours_per_week is not None:
        if job.hours_per_week > LABOR_RULES["max_hours_per_week_break"]:
            blocked = True
            reasons.append(f"{job.hours_per_week} h/week exceeds the maximum for minors")
        elif job.hours_per_week > LABOR_RULES["max_hours_per_week_school"]:
            review = True
            reasons.append(f"{job.hours_per_week} h/week only works during school holidays")
    else:
        review = True
        reasons.append("Weekly hours not listed")

    if job.job_type.lower() in {"full-time", "full time"}:
        blocked = True
        reasons.append("Full-time role is not compatible with school")

    if blocked:
        return PrescreenResult(verdict="blocked", tag="Not for 16", reasons=reasons)
    if review:
        return PrescreenResult(verdict="review", tag="Needs Review", reasons=reasons)
    return PrescreenResult(verdict="approved", tag="16+ Approved", reasons=["Hours, shift times and duties pass the student-safety check"])


_WORD_RE = re.compile(r"[a-z][a-z+#-]{2,}")


def quick_match(profile: StudentProfile, job: Job) -> int:
    """Cheap keyword-overlap score shown before the AI has scored the job."""
    student_terms = set()
    for chunk in profile.subjects + profile.hobbies + profile.strengths + profile.achievements:
        student_terms.update(_WORD_RE.findall(chunk.lower()))
    job_terms = set(_WORD_RE.findall(" ".join([job.title, job.description, " ".join(job.tags)]).lower()))
    if not student_terms or not job_terms:
        return 35
    overlap = len(student_terms & job_terms)
    score = 35 + min(overlap, 8) * 7
    if job.location and profile.location and job.location.lower().split(",")[0] == profile.location.lower().split(",")[0]:
        score += 5
    return max(0, min(score, 92))


# ---------------------------------------------------------------------------
# Sample local job feed (replace with a real feed / scraper / DB)
# ---------------------------------------------------------------------------

SAMPLE_JOBS: list[Job] = [
    Job(
        id="job-001", title="Weekend Cafe Assistant", company="Riverside Coffee House",
        location="Downtown", pay="$14.50/hr", schedule="Sat & Sun, 09:00-15:00", hours_per_week=12,
        shift_start="09:00", shift_end="15:00", job_type="Part-time", min_age=16,
        description="Greet customers, take orders on the till, keep tables clean and help the baristas restock. Full training given. Friendly, supervised team.",
        tags=["customer service", "teamwork", "communication", "food"], posted_at="2026-09-25",
    ),
    Job(
        id="job-002", title="Junior Library Helper", company="City Public Library",
        location="Northside", pay="$13.00/hr", schedule="Tue & Thu 16:00-19:00, Sat 10:00-14:00", hours_per_week=10,
        shift_start="16:00", shift_end="19:00", job_type="Part-time", min_age=16,
        description="Shelve returned books, help visitors find titles, support the children's reading club and set up for community events.",
        tags=["organisation", "reading", "english", "community", "kids"], posted_at="2026-09-24",
    ),
    Job(
        id="job-003", title="Summer Camp Activity Leader", company="Lakeside Youth Camp",
        location="Lakeside", pay="$15.00/hr", schedule="Mon-Fri 08:30-16:30, July only", hours_per_week=38,
        shift_start="08:30", shift_end="16:30", job_type="Seasonal", min_age=16,
        description="Lead games, sports and craft sessions for 8-12 year olds alongside senior leaders. First-aid training provided.",
        tags=["sports", "leadership", "kids", "art", "teamwork", "PE"], posted_at="2026-09-22",
    ),
    Job(
        id="job-004", title="Peer Maths Tutor", company="BrightPath Tutoring",
        location="Online / Downtown", pay="$18.00/hr", schedule="Flexible, 2-6 h/week after school", hours_per_week=6,
        shift_start="16:00", shift_end="19:00", job_type="Part-time", min_age=16,
        description="Help younger students with maths homework using our online whiteboard. Great for students with strong maths grades and patience.",
        tags=["maths", "teaching", "patience", "communication", "science"], posted_at="2026-09-21",
    ),
    Job(
        id="job-005", title="Retail Sales Associate", company="Trailhead Sports",
        location="Westfield Mall", pay="$14.00/hr", schedule="Thu-Sat, shifts to 22:30", hours_per_week=16,
        shift_start="17:00", shift_end="22:30", job_type="Part-time", min_age=16,
        description="Help customers choose sports gear, restock shelves and keep the store tidy. Late-closing shifts required on Thursday and Friday.",
        tags=["sports", "customer service", "retail"], posted_at="2026-09-20",
    ),
    Job(
        id="job-006", title="Warehouse Picker", company="QuickShip Logistics",
        location="Industrial Park", pay="$16.00/hr", schedule="Night shift 22:00-06:00", hours_per_week=30,
        shift_start="22:00", shift_end="06:00", job_type="Part-time", min_age=18,
        description="Pick and pack orders, operate a forklift after certification. Industrial environment.",
        tags=["logistics"], posted_at="2026-09-19",
    ),
    Job(
        id="job-007", title="Junior Content Creator (Social Media)", company="Greenleaf Community Garden",
        location="Eastside", pay="$13.50/hr", schedule="Sat 10:00-14:00 + 2 h remote", hours_per_week=6,
        shift_start="10:00", shift_end="14:00", job_type="Part-time", min_age=16,
        description="Photograph garden events, draft short posts and help run the volunteer sign-up table. Ideal for creative students interested in media or the environment.",
        tags=["photography", "art", "writing", "social media", "environment", "creativity"], posted_at="2026-09-18",
    ),
    Job(
        id="job-008", title="Dog Walker & Kennel Helper", company="Happy Paws Daycare",
        location="Northside", pay="$13.00/hr", schedule="Weekends + school holidays", hours_per_week=None,
        shift_start=None, shift_end=None, job_type="Weekend", min_age=16,
        description="Walk friendly dogs in the park, refill water bowls and help clean play areas. Must love animals.",
        tags=["animals", "outdoors", "responsibility", "biology"], posted_at="2026-09-17",
    ),
]


# ---------------------------------------------------------------------------
# Claude client helpers
# ---------------------------------------------------------------------------

_client: anthropic.Anthropic | None = None


def get_client() -> anthropic.Anthropic:
    """Lazily build the Anthropic client so the API boots (and /api/jobs works) without a key."""
    global _client
    if _client is None:
        if not os.getenv("ANTHROPIC_API_KEY") and not os.getenv("ANTHROPIC_AUTH_TOKEN"):
            logger.warning("ANTHROPIC_API_KEY is not set - AI endpoints will fail until it is provided.")
        _client = anthropic.Anthropic()
    return _client


def _profile_block(profile: StudentProfile) -> str:
    return json.dumps(profile.model_dump(), ensure_ascii=False, indent=2)


def _job_block(job: Job, prescreen: PrescreenResult) -> str:
    payload = job.model_dump()
    payload["automated_prescreen"] = prescreen.model_dump()
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _call_claude(system: str, user_content: str, output_format: type[BaseModel]):
    """Single structured call with typed error handling.  Returns the parsed model."""
    client = get_client()
    try:
        response = client.beta.messages.parse(
            model=CLAUDE_MODEL,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_content}],
            output_format=output_format,
            output_config={"effort": CLAUDE_EFFORT},
            # If a safety classifier declines, re-run the same request on a fallback model server-side.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError as exc:
        raise HTTPException(status_code=401, detail="Anthropic API key missing or invalid on the server.") from exc
    except anthropic.RateLimitError as exc:
        raise HTTPException(status_code=429, detail="The AI service is busy. Please try again in a moment.") from exc
    except anthropic.BadRequestError as exc:
        logger.error("Bad request to Claude: %s", exc)
        raise HTTPException(status_code=502, detail="The AI request was rejected. Check the server logs.") from exc
    except anthropic.APIStatusError as exc:
        logger.error("Claude API error %s: %s", exc.status_code, exc)
        raise HTTPException(status_code=502, detail="The AI service returned an error. Please try again.") from exc
    except anthropic.APIConnectionError as exc:
        raise HTTPException(status_code=503, detail="Could not reach the AI service.") from exc

    if response.stop_reason == "refusal":
        raise HTTPException(status_code=422, detail="The AI declined to process this job posting.")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise HTTPException(status_code=502, detail="The AI response was incomplete. Please try again.")
    return response.parsed_output, response.model


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Teen Job Finder API",
    version="1.0.0",
    description="Student-safe job matching, CV profile and recruiter-message generation powered by Claude.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": CLAUDE_MODEL,
        "ai_configured": bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")),
        "time": _now(),
    }


class JobFeed(BaseModel):
    jobs: list[JobCard]
    sources: dict[str, str]
    live: bool = Field(description="False when the feed fell back to the built-in sample jobs")


@app.get("/api/jobs", response_model=JobFeed)
async def list_jobs(
    location: str = "",
    subjects: str = "",
    hobbies: str = "",
    strengths: str = "",
    query: str = "",
    country: str = "",
    include_blocked: bool = False,
) -> JobFeed:
    """Live job feed from real job boards, pre-screened for 16-year-olds.

    Sources are configured in job_sources.py (Adzuna needs a free API key; the
    others need none).  When every source fails or returns nothing, the
    built-in sample jobs are served so the app still works offline.
    Query params are comma-separated so the frontend can call this before the
    full profile has been saved.
    """
    profile = StudentProfile(
        location=location,
        subjects=[s for s in subjects.split(",") if s.strip()],
        hobbies=[s for s in hobbies.split(",") if s.strip()],
        strengths=[s for s in strengths.split(",") if s.strip()],
    )
    raw, status = await job_sources.fetch_all(query=query, location=location, country=country or JOB_COUNTRY)
    live = bool(raw)
    jobs = [Job(**r) for r in raw] if raw else SAMPLE_JOBS
    cards: list[JobCard] = []
    for job in jobs:
        screen = prescreen_job(job)
        if screen.verdict == "blocked" and not include_blocked:
            continue
        cards.append(JobCard(**job.model_dump(), prescreen=screen, quick_match=quick_match(profile, job)))
    cards.sort(key=lambda c: (c.prescreen.verdict != "approved", -c.quick_match))
    return JobFeed(jobs=cards, sources=status if live else {"sample": f"{len(SAMPLE_JOBS)} built-in jobs (no live source answered)"}, live=live)


@app.post("/api/process-job", response_model=ProcessJobResponse)
def process_job(payload: ProcessJobRequest) -> ProcessJobResponse:
    """Score a job for a student, verify it is safe/legal, and draft the CV profile + recruiter message."""
    prescreen = prescreen_job(payload.job)

    user_content = (
        "<student_profile>\n" + _profile_block(payload.profile) + "\n</student_profile>\n\n"
        "<job_posting>\n" + _job_block(payload.job, prescreen) + "\n</job_posting>\n\n"
        "Evaluate this job for this student. The automated_prescreen is a rule-based hint: confirm or "
        "override it with your own reasoning, and explain any disagreement in legal.concerns."
    )

    analysis, served_model = _call_claude(SYSTEM_PROMPT, user_content, JobAnalysis)

    # Hard safety floor: the deterministic screen can only make the result stricter, never looser.
    if prescreen.verdict == "blocked" and analysis.legal.is_safe_for_16:
        analysis.legal.is_safe_for_16 = False
        analysis.legal.tag = "Not for 16"
        analysis.legal.concerns = list(dict.fromkeys(prescreen.reasons + analysis.legal.concerns))
        analysis.recommendation = "skip"
        analysis.match_score = min(analysis.match_score, 30)

    return ProcessJobResponse(
        job_id=payload.job.id,
        analysis=analysis,
        prescreen=prescreen,
        model=served_model,
        generated_at=_now(),
    )


@app.post("/api/generate-assets", response_model=GenerateAssetsResponse)
def generate_assets(payload: GenerateAssetsRequest) -> GenerateAssetsResponse:
    """Build a general CV profile and recruiter invitation message from the student's profile alone."""
    if not (payload.profile.subjects or payload.profile.hobbies or payload.profile.strengths):
        raise HTTPException(status_code=400, detail="Add at least one subject, hobby or strength first.")

    user_content = (
        "<student_profile>\n" + _profile_block(payload.profile) + "\n</student_profile>\n\n"
        f"<target_role>{payload.target_role}</target_role>\n\n"
        "Generate the student's application assets for this type of role."
    )
    assets, served_model = _call_claude(ASSETS_SYSTEM_PROMPT, user_content, AssetBundle)
    return GenerateAssetsResponse(assets=assets, model=served_model, generated_at=_now())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=True)
