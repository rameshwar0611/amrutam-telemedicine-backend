"""Editable source for architecture-submission.pdf (text and vector diagrams).

From the repository root: python3 docs/render-architecture.py
Documentation-only requirements: reportlab==4.4.9, pypdf==6.10.0.
Uses installed Liberation Sans / DejaVu fonts; never downloads assets or reads .env.
Page images for visual review: pdftoppm -r 150 -png docs/architecture-submission.pdf work/architecture-review/page
All application claims refer to implementation commit 9f09a95, reviewed 21 Oct 2026.
"""

from pathlib import Path
import json
import math
import re

from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/architecture-submission.pdf"
REVIEW = ROOT / "work/architecture-review"
REVIEW.mkdir(parents=True, exist_ok=True)
W, H = A4
M = 38
CW = W - 2 * M
INK = HexColor("#183442")
TEAL = HexColor("#09685F")
SLATE = HexColor("#526775")
LINE = HexColor("#BCCBD0")
PALE = HexColor("#F1F6F6")
BLUE = HexColor("#EEF2F7")
AMBER = HexColor("#8C611D")
SAND = HexColor("#FAF6ED")

for name, file in [
    ("Body", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    ("Body-Bold", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ("Body-Italic", "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf"),
    ("Code", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
]:
    if not Path(file).is_file() and "/liberation/" in file:
        file = file.replace("/liberation/", "/liberation2/")
    if not Path(file).is_file():
        raise FileNotFoundError(f"Install fonts-liberation / fonts-dejavu-core: {file}")
    pdfmetrics.registerFont(TTFont(name, file))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body-Italic")

C = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1, invariant=1)
C.setTitle("Amrutam Telemedicine | Backend Architecture")
C.setAuthor("Amrutam backend engineering submission")
C.setSubject("Implementation-grounded architecture; reviewed commit 9f09a95; 21 October 2026")
C.setCreator("docs/render-architecture.py • ReportLab")
BOXES = []
PAGE = 0


def bounds(x, top, width, height, label):
    assert x >= 20 and top >= 20 and x + width <= W - 20 and top + height < H - 20, (
        PAGE, label, x, top, width, height
    )
    BOXES.append(dict(page=PAGE, label=label, x=x, top=top, width=width, height=height))


def text(x, top, value, size=9.4, font="Body", color=INK, anchor="left", track=True):
    width = pdfmetrics.stringWidth(value, font, size)
    left = x - width / 2 if anchor == "center" else x - width if anchor == "right" else x
    if track:
        bounds(left, top, width, size * 1.1, value)
    C.setFont(font, size)
    C.setFillColor(color)
    C.drawString(left, H - top - size, value)


def para(x, top, width, value, size=9.5, leading=12.4, color=INK, max_h=None):
    style = ParagraphStyle("p", fontName="Body", fontSize=size, leading=leading,
                           textColor=color, spaceAfter=0)
    p = Paragraph(value, style)
    _, height = p.wrap(width, H)
    if max_h is not None:
        assert height <= max_h, (PAGE, value[:70], height, max_h)
    bounds(x, top, width, height, value[:80])
    p.drawOn(C, x, H - top - height)
    return top + height


def rect(x, top, width, height, fill=white, stroke=LINE, radius=5, dash=None):
    C.saveState()
    C.setFillColor(fill)
    C.setStrokeColor(stroke)
    C.setLineWidth(0.65)
    if dash:
        C.setDash(*dash)
    C.roundRect(x, H - top - height, width, height, radius, fill=1, stroke=1)
    C.restoreState()


def line(points, color=SLATE, width=0.8, dash=None, arrow=False, both=False):
    C.saveState()
    C.setStrokeColor(color)
    C.setFillColor(color)
    C.setLineWidth(width)
    if dash:
        C.setDash(*dash)
    p = C.beginPath()
    p.moveTo(points[0][0], H - points[0][1])
    for x, t in points[1:]:
        p.lineTo(x, H - t)
    C.drawPath(p)
    C.setDash()

    def head(a, b):
        angle = math.atan2(b[1] - a[1], b[0] - a[0])
        length, half = 4.5, 2.1
        x, y = b
        q = C.beginPath()
        q.moveTo(x, H - y)
        for sign in [-1, 1]:
            q.lineTo(x - length * math.cos(angle) + sign * half * math.sin(angle),
                     H - (y - length * math.sin(angle) - sign * half * math.cos(angle)))
        q.close()
        C.drawPath(q, fill=1, stroke=0)

    if arrow:
        head(points[-2], points[-1])
    if both:
        head(points[1], points[0])
    C.restoreState()


def section(x, top, heading, width=None, tag=None):
    text(x, top, heading, 11.8, "Body-Bold", TEAL)
    if tag and width:
        text(x + width, top + 2, tag, 7.4, "Body-Bold", SLATE, "right")
    return top + 22


def block(x, top, width, heading, body, tag=None, size=9.4):
    y = section(x, top, heading, width, tag)
    return para(x, y, width, body, size=size, leading=12.25)


def page(number, title, subtitle, source):
    global PAGE
    PAGE = number
    text(M, 28, "AMRUTAM  /  TELEMEDICINE BACKEND", 8.2, "Body-Bold", TEAL)
    text(W - M, 28, "ENGINEERING ARCHITECTURE  •  21 OCT 2026", 7.7, color=SLATE, anchor="right")
    text(M, 53, title, 25, "Body-Bold")
    para(M, 89, CW, subtitle, 10.1, 13.2, SLATE)
    line([(M, 799), (W - M, 799)], LINE, 0.65)
    text(M, 808, "Reviewed implementation 9f09a95  •  Documentation only", 7.4, color=SLATE)
    text(W - M, 808, f"{number} / 4", 8, "Body-Bold", anchor="right")
    text(M, 785, source, 7.2, color=SLATE)


def node(x, top, width, height, heading, detail, fill=white, title_size=11):
    rect(x, top, width, height, fill)
    text(x + 12, top + 9, heading, title_size, "Body-Bold", TEAL)
    para(x + 12, top + 27, width - 24, detail, 9, 11.7, max_h=height - 30)


def system_page():
    page(1, "System architecture", "A modular REST backend: one codebase, separate API and worker processes, PostgreSQL as the source of truth.",
         "Sources: composition-root.ts; compose*.yaml; infra/terraform/; docs/openapi.json")
    text(M, 127, "IMPLEMENTED & LOCALLY VERIFIED", 8.3, "Body-Bold", TEAL)
    text(W - M, 127, "Solid: application/data flow   ·   Dashed: telemetry or dependency", 8.0, color=SLATE, anchor="right")
    rect(M, 148, CW, 361, PALE, PALE, 7)
    node(222, 162, 152, 43, "REST clients", "Patient · Doctor · Admin", title_size=10.5)
    node(68, 248, 242, 77, "Express 5 API · Node.js 24", "Strict TypeScript · Zod · OpenAPI 3.1<br/>Controllers → services → repositories")
    node(392, 255, 130, 65, "Redis", "Shared limits<br/>Doctor metadata cache")
    node(68, 370, 242, 65, "PostgreSQL 17 · Kysely / pg", "Business + identity records<br/>Audit, idempotency and durable outbox")
    node(392, 370, 130, 65, "Background worker", "Leases · receipts<br/>Fake compensation", title_size=10)
    line([(298, 205), (298, 225), (189, 225), (189, 248)], TEAL, arrow=True)
    text(237, 210, "REST /v1", 8.2, color=TEAL)
    line([(310, 285), (392, 285)], TEAL, arrow=True, both=True)
    text(351, 270, "limits / cache", 8.2, color=SLATE, anchor="center")
    line([(189, 325), (189, 370)], TEAL, arrow=True, both=True)
    text(203, 340, "SQL transactions", 8.4, color=SLATE)
    line([(392, 402), (310, 402)], TEAL, arrow=True, both=True)
    text(351, 387, "lease / ack", 8.2, color=SLATE, anchor="center")
    line([(457, 370), (457, 320)], SLATE, dash=(2, 3), arrow=True)
    text(468, 341, "health", 8.1, color=SLATE)
    rect(68, 465, 454, 28, white, LINE, 3)
    text(295, 473, "OTel collector → Prometheus + Tempo → Grafana", 9.2, "Body-Bold", anchor="center")
    line([(84, 325), (54, 325), (54, 479), (68, 479)], SLATE, dash=(2, 3), arrow=True)
    line([(457, 435), (457, 465)], SLATE, dash=(2, 3), arrow=True)
    text(470, 445, "OTLP", 7.7, color=SLATE)

    rect(M, 522, CW, 75, BLUE, LINE, 5, dash=(3, 3))
    text(M + 12, 531, "AWS MAPPING · DEFINED IN TERRAFORM, NOT DEPLOYED", 8.5, "Body-Bold", SLATE)
    para(M + 12, 548, CW - 24,
         "HTTPS ALB → private ECS Fargate API / worker; RDS PostgreSQL Multi-AZ; replicated Valkey-compatible cache. "
         "Private ECR/endpoints, IAM, KMS and secret references; ADOT → X-Ray / CloudWatch. No AWS deployment or paid provisioning is claimed.", 9.25, 12)

    left, right, col = M, 310, 247
    block(left, 616, col, "Modules and ownership",
          "Identity and MFA; owned availability and discovery; booking/cancellation; clinical notes and prescriptions; "
          "internal payments, audit and admin analytics. Constructor injection and an explicit composition root bind ports "
          "to infrastructure; transaction-scoped repositories share one SQL connection. "
          "Operator-only bootstrap is locked out after the first admin.")
    block(right, 616, col, "API and clinical boundaries",
          "37 OpenAPI paths cover the implemented surface. Consultation states: scheduled → in_progress → completed; "
          "scheduled → cancelled / no_show. Assigned doctors author notes and prescriptions; patients see only their own "
          "finalized prescriptions. Admin analytics use bounded date ranges and an asOf timestamp.")
    para(M, 746, CW, "Local Compose uses development DB/Redis connections; production requires verified PostgreSQL and Redis TLS. "
         "Forwarded addresses are untrusted unless ingress CIDRs are explicit. No frontend, video calling or real payment gateway.",
         8.8, 11.2, SLATE, max_h=34)
    C.showPage()


CORE = {
    "users": ["id  PK", "email  UK", "role / status / auth_version"],
    "profiles": ["user_id  PK, FK", "display_name / time_zone"],
    "audit_logs": ["(occurred_at, id)  PK", "actor_id  FK?", "action / resource / outcome"],
    "doctors": ["id  PK", "user_id  FK, UK", "public_name / specialty"],
    "availability_slots": ["id  PK", "doctor_id  FK", "starts_at / ends_at", "status"],
    "consultations": ["id  PK", "patient_id  FK → users", "slot_id / doctor_id  FK*", "doctor_id  FK → doctors", "status / version"],
    "prescriptions": ["id  PK", "consultation_id  FK*", "doctor_id  FK* → doctors", "correction_of  FK? → self", "version / status"],
    "payments": ["id  PK", "consultation_id  FK", "amount_minor  bigint", "currency / status"],
}


def entity(x, top, name, width=151):
    fields = CORE[name]
    height = 27 + 12 * len(fields) + 6
    rect(x, top, width, height, white, LINE, 4)
    C.setFillColor(PALE)
    C.roundRect(x + 0.5, H - top - 26, width - 1, 25.5, 4, fill=1, stroke=0)
    text(x + 9, top + 6, name, 10.1, "Body-Bold", TEAL)
    for i, value in enumerate(fields):
        text(x + 9, top + 31 + i * 12, value, 8.0, "Code")
    return height


def cardinal(x, top, label):
    text(x, top, label, 7.7, "Body-Bold", SLATE)


def data_page():
    page(2, "Data model & integrity", "Eight core tables and ten supporting tables. Physical keys and relationships follow SQL migrations 0001–0009.",
         "Sources: migrations/0001–0009; database/types.ts. Logical support tables exclude audit child partitions.")
    text(M, 124, "CORE ER DIAGRAM", 8.5, "Body-Bold", TEAL)
    text(W - M, 124, "PK primary · FK foreign · UK unique · ? nullable", 8.2, color=SLATE, anchor="right")

    # Lines are drawn before entities; endpoint labels show parent/child cardinality.
    line([(223, 172), (189, 172)], arrow=True)
    cardinal(210, 156, "1"); cardinal(189, 180, "0..1")
    line([(374, 172), (406, 172)], arrow=True)
    cardinal(376, 156, "0..1"); cardinal(387, 180, "0..N")
    line([(223, 196), (205, 196), (205, 240), (113, 240), (113, 262)], arrow=True)
    cardinal(211, 210, "1"); cardinal(123, 246, "0..1")
    line([(298, 220), (298, 385)], arrow=True)
    cardinal(308, 231, "1  patient"); cardinal(308, 367, "0..N")
    line([(113, 331), (113, 385)], arrow=True)
    cardinal(123, 338, "1"); cardinal(123, 367, "0..N")
    line([(189, 294), (239, 294), (239, 385)], arrow=True)
    cardinal(195, 278, "1"); cardinal(245, 367, "0..N")
    # Redundant physical doctor FK to prescriptions; white bridges distinguish crossings.
    line([(189, 311), (207, 311), (207, 348), (482, 348), (482, 385)], arrow=True)
    for cross in (239, 298):
        C.setFillColor(white)
        C.rect(cross - 3, H - 351, 6, 6, fill=1, stroke=0)
        line([(cross - 4, 348), (cross - 2, 344), (cross + 2, 344), (cross + 4, 348)])
    text(342, 333, "doctor authorship", 8.0, color=SLATE)
    cardinal(195, 315, "1"); cardinal(490, 367, "0..N")
    line([(189, 423), (223, 423)], arrow=True)
    cardinal(193, 408, "1"); cardinal(191, 435, "0..N")
    line([(374, 423), (406, 423)], arrow=True)
    cardinal(378, 408, "1"); cardinal(378, 435, "0..N")
    line([(298, 478), (298, 508)], arrow=True)
    cardinal(308, 480, "1"); cardinal(308, 493, "0..N")
    line([(557, 449), (573, 449), (573, 495), (482, 495), (482, 478)], arrow=True)
    text(557, 499, "0..1 prior; 0..N corrections", 7.7, color=SLATE, anchor="right")

    entity(223, 145, "users")
    entity(38, 145, "profiles")
    entity(406, 145, "audit_logs")
    entity(38, 262, "doctors")
    entity(38, 385, "availability_slots")
    entity(223, 385, "consultations")
    entity(406, 385, "prescriptions")
    entity(223, 508, "payments")

    para(M, 596, CW,
         "<b>* Composite FKs:</b> consultations(slot_id, doctor_id) → availability_slots(id, doctor_id); "
         "prescriptions(consultation_id, doctor_id) → consultations(id, doctor_id). Core IDs: UUID; time: timestamptz. "
         "Audit partitions use occurred_at.", 8.6, 11.1, SLATE, max_h=38)
    text(M, 627, "SUPPORTING KEYS & RELATIONSHIPS", 8.5, "Body-Bold", TEAL)
    support = [
        ("auth_sessions", "PK id · FK user_id → users"),
        ("refresh_token_history", "PK token_hash · FK session_id → auth_sessions"),
        ("auth_flows", "PK id · FK user_id → users"),
        ("mfa_factors", "PK id · UK/FK user_id → users; composite FK\n(enrollment_flow_id, user_id) → auth_flows"),
        ("mfa_recovery_codes", "PK id · FK user_id → users"),
        ("auth_tokens", "PK id · FK user_id → users"),
        ("idempotency_records", "PK id · FK actor_id? → users · UK (scope, key)"),
        ("outbox_jobs", "PK id · UK deduplication_key · optional trace_parent"),
        ("job_receipts", "PK/FK job_id → outbox_jobs.id (one receipt/job)"),
        ("doctor_directory_revision", "PK id (singleton) · generation UUID; no FK"),
    ]
    for col, items in enumerate((support[:5], support[5:])):
        x = M if col == 0 else 310
        y = 644
        for title, detail in items:
            text(x, y, title, 8.6, "Body-Bold")
            y = para(x, y + 11, 247, detail.replace("\n", "<br/>"), 8.4, 10.5, SLATE) + 1.5
    C.showPage()


def seq_arrow(a, b, top, label, dashed=False):
    line([(a, top), (b, top)], TEAL, 0.9, dash=(3, 2) if dashed else None, arrow=True)
    text((a + b) / 2, top - 15, label, 8.3, anchor="center")


def note(x, top, width, heading, value, height):
    rect(x, top, width, height, PALE, LINE, 5)
    text(x + 11, top + 10, heading, 10, "Body-Bold", TEAL)
    para(x + 11, top + 30, width - 22, value, 9.2, 12, max_h=height - 37)


def booking_page():
    page(3, "Booking without double allocation", "POST /v1/consultations · patientId comes from the authenticated actor, never from request input.",
         "Sources: booking.service.ts; booking.repository.ts; idempotency.*; tests/integration/booking.test.ts")
    xs = [74, 210, 348, 512]
    names = ["Patient", "HTTP / security", "Booking service", "PostgreSQL"]
    for x, name in zip(xs, names):
        rect(x - 44, 140, 88, 29, PALE, LINE, 4)
        text(x, 149, name, 9.1, "Body-Bold", anchor="center")
        line([(x, 169), (x, 760)], LINE, 0.7, dash=(2, 3))
    seq_arrow(xs[0], xs[1], 200, "slotId + Idempotency-Key")
    rect(151, 218, 118, 35, white, LINE, 3)
    para(157, 224, 106, "Zod · live auth · MFA<br/>Patient RBAC · rate limit", 8.5, 10.4)
    seq_arrow(xs[1], xs[2], 278, "Actor + validated request")
    rect(312, 298, 245, 357, PALE, LINE, 4)
    text(324, 307, "BEGIN · READ COMMITTED", 9.1, "Body-Bold", TEAL)
    for x in xs[2:]:
        line([(x, 328), (x, 646)], LINE, 0.65, dash=(2, 3))
    seq_arrow(xs[2], xs[3], 343, "Revalidate / lock user + session")
    seq_arrow(xs[2], xs[3], 380, "Claim scope/key; lock retry row")
    rect(322, 394, 225, 64, white, LINE, 3)
    text(332, 403, "ALT · EXISTING LOGICAL REQUEST", 8.1, "Body-Bold", TEAL)
    para(332, 419, 205, "Same canonical HMAC: decrypt saved status/body. Changed body or expired key: 409. "
         "Replay does not repeat booking writes.", 8.8, 11)
    text(324, 470, "NEW KEY · 24h TTL", 8.1, "Body-Bold", TEAL)
    seq_arrow(xs[2], xs[3], 502, "Doctor SHARE; slot FOR UPDATE")
    seq_arrow(xs[2], xs[3], 539, "Recheck future / open / unoccupied")
    seq_arrow(xs[2], xs[3], 576, "Insert booking + audit + outbox")
    seq_arrow(xs[2], xs[3], 624, "Encrypt replay result; COMMIT")
    seq_arrow(xs[3], xs[2], 688, "201 + safe consultation DTO", True)
    seq_arrow(xs[2], xs[1], 722, "Original status + response", True)
    seq_arrow(xs[1], xs[0], 755, "Safe retry after lost response", True)

    note(38, 308, 235, "Database-enforced invariants",
         "GiST excludes overlapping doctor slots using [start, end) ranges. "
         "The unique slot index covers every status except cancelled, including completed and no_show. "
         "An INSERT trigger also locks and rejects blocked slots.", 126)
    note(38, 454, 235, "Atomic outcome and evidence",
         "Booking, audit, encrypted idempotency result and outbox commit or roll back together. "
         "Tests: 100 distinct-key attempts → one success; 100 identical retries → one consultation, one audit and one logical event.", 125)
    note(38, 600, 235, "No network side effects in SQL",
         "No Redis or adapter calls inside booking SQL. Workers lease only committed outbox events. "
         "Booking has no payment prerequisite. Expected conflicts return 409; unexpected persistence failures roll back.", 106)
    C.showPage()


def prose_sections(x, top, width, groups, size=9.35, leading=12.0, gap=18):
    y = top
    for heading, content in groups:
        y = section(x, y, heading)
        for i, paragraph in enumerate(content):
            if i:
                y += 7
            y = para(x, y, width, paragraph, size, leading)
        y += gap
    return y


def operations_page():
    page(4, "Security, operations & evidence", "Implemented controls are separated from undeployed infrastructure and proposed production objectives.",
         "Evidence: phase5-verification.md; evidence/performance-local.json; backup-dr.md; GitHub CI for 9f09a95")
    col = 247
    left_end = prose_sections(M, 133, 253, [
        ("Authentication and authorization", [
            "Registration returns a generic response; activation/password login issue MFA-only challenges, not application access. "
            "Argon2id hashes passwords. MFA requires TOTP with atomic timestep replay protection or a single-use recovery code. "
            "Only the authorized enrollment URI discloses the seed.",
            "Ed25519/EdDSA access JWTs default to 5 minutes; verification fixes algorithm, key ID, issuer, audience, token type and lifetime. "
            "Every protected operation rechecks live role, activation, auth version and session revocation/expiry. "
            "Patient/doctor ownership and recent-MFA admin gates prevent role or object escalation.",
            "Opaque refresh tokens rotate with hashed all-generation history; known reuse revokes the family. "
            "Encrypted identical auth retries have a short window (30 seconds default). Sensitive account changes revoke sessions. "
            "No public doctor/admin registration; setup delivery remains an audited manual operator action.",
        ]),
        ("Data protection and compliance", [
            "AES-256-GCM with record/purpose-bound AAD encrypts MFA secrets, clinical notes, prescription content and replay responses. "
            "Environment key maps support key IDs/versions; full rotation/recovery drills remain open. "
            "Zod validation, safe DTOs, no-store responses, parameterized SQL and redacted errors/logs limit disclosure.",
            "SQL guards freeze completed notes and finalized prescription contents; corrections create linked versions. "
            "Clinical reads and privileged actions are audited atomically. Monthly audit partitions have append-only runtime controls "
            "and a fallback; function-only maintenance creates future partitions and removes expired security records after a 7-day grace. "
            "Audit/clinical deletion and legal retention are not automated.",
        ]),
        ("Verified evidence; explicit limits", [
            "219 tests recorded (72 unit / 147 integration); hosted Backend CI and infrastructure/security checks passed for 9f09a95. "
            "Coverage includes concurrency, replay, access denial, rollback and worker crash recovery.",
            "Local sample: 1,000 historical consultations, 50 writes and 200 reads; p95 14.42 ms reads / 19.87 ms writes, zero errors. "
            "This is not sustained capacity or production ingress proof. The recorded image scan retains 56 HIGH / 1 CRITICAL vendor-unfixed findings; "
            "the automated gate rejects fixable HIGH/CRITICAL only.",
        ]),
    ], size=9.15, leading=11.65, gap=10)

    right_end = prose_sections(310, 133, col, [
        ("Scalability and reliability", [
            "PostgreSQL owns slot truth. Indexed doctor/time/status lookups, trigram name search, bounded pagination, UTC timestamps "
            "and bounded connection/query deadlines constrain work. Discovery caches public doctor fields for 30 seconds with a SQL generation check; "
            "time-filtered availability bypasses cache. Cache errors fall back to SQL; security rate limiting fails closed. "
            "Further partitioning and aggregate caches await measurement.",
            "Workers use SKIP LOCKED leases, owner/attempt/expiry fencing and durable receipts. Retries use exponential backoff with jitter, "
            "a 60-second cap and an 8-attempt default; terminal failures are visible. Fake refunds use stable keys outside transactions. "
            "Cancellation uses doctor → slot → consultation lock order. Only future scheduled visits can be cancelled; "
            "rebooking requires a prior cancellation.",
        ]),
        ("Operations and delivery", [
            "Non-root, read-only API/worker containers expose liveness/readiness and drain on shutdown. Worker credentials cannot read clinical "
            "notes/prescriptions/users/audit history and include no auth keys. Owner migrations use checksum validation, an advisory lock and one transaction/version.",
            "Allowlisted HTTP, Kysely and consumer spans propagate traceparent through the outbox. Metrics, redacted trace-correlated logs, "
            "Prometheus/Tempo/Grafana and nine local alerts are verified. Raw SQL, bodies, credentials and clinical content are excluded from telemetry.",
            "Terraform defines two-AZ private services, 2 API/2 worker tasks, API scaling 2–10, encrypted RDS/cache and secret references. "
            "Manual main-only OIDC deployment is defined: scan → migrate → roll → smoke; failure restores old task images, not schema. "
            "AWS delivery, paging and failover remain unverified.",
        ]),
        ("Backup and disaster recovery", [
            "RDS 14-day automated backups, final snapshots and cache 7-day snapshots are defined, not deployed. "
            "An isolated logical restore verified counts and reapplied runtime grants; PITR, regional copies and key recovery were not tested. "
            "Recover to a new private DB, restore grants/keys, validate integrity and reconcile sessions/outbox before cutover. "
            "Redis is rebuilt, never used to recover bookings.",
        ]),
    ], size=9.15, leading=11.65, gap=10)

    assert max(left_end, right_end) < 738, (left_end, right_end)
    rect(M, 736, CW, 42, SAND, LINE, 4)
    para(M + 10, 742, CW - 20,
         "<b>PROPOSED, NOT ACHIEVED:</b> 100k consultations/day; p95 &lt;200 ms reads / &lt;500 ms writes; 99.95% availability. "
         "PITR RPO/RTO 5 min / 60 min; regional copy 24 h / 4 h. Capacity, failover, retention policy and full DR/key drills require production validation. Regional DR can exceed the monthly availability budget.",
         8.6, 10.7, AMBER, max_h=34)
    C.showPage()


def verify_evidence():
    """Fail on accidental divergence of schema names / critical booking semantics."""
    sql = "\n".join(p.read_text() for p in sorted((ROOT / "migrations").glob("*.up.sql")))
    expected = set(CORE) | {"auth_sessions", "refresh_token_history", "auth_flows", "mfa_factors",
                          "mfa_recovery_codes", "auth_tokens", "idempotency_records", "outbox_jobs",
                          "job_receipts", "doctor_directory_revision"}
    actual = set(re.findall(r"CREATE TABLE (\w+)\s*\(", sql)) - {"audit_logs_default"}
    assert actual == expected, (actual - expected, expected - actual)
    assert "WHERE status <> 'cancelled'" in sql
    assert "FOREIGN KEY (slot_id, doctor_id)" in sql
    assert "FOREIGN KEY (consultation_id, doctor_id)" in sql
    assert "FOREIGN KEY (enrollment_flow_id, user_id)" in sql
    assert len(json.loads((ROOT / "docs/openapi.json").read_text())["paths"]) == 37


if __name__ == "__main__":
    verify_evidence()
    system_page()
    data_page()
    booking_page()
    operations_page()
    # Conservative text rectangles catch collisions before accepting the artifact.
    for i, a in enumerate(BOXES):
        for b in BOXES[i + 1:]:
            if a["page"] != b["page"]:
                continue
            dx = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
            dy = min(a["top"] + a["height"], b["top"] + b["height"]) - max(a["top"], b["top"])
            assert not (dx > 1 and dy > 1), (a["page"], "Text overlap", a["label"], b["label"])
    C.save()
    reader = PdfReader(OUT)
    assert len(reader.pages) == 4
    assert all(len(p.extract_text()) > 800 for p in reader.pages)
    (REVIEW / "layout-bounds.json").write_text(json.dumps(BOXES, indent=2))
    print(f"Generated {OUT}: 4 A4 pages; schema references and page bounds verified.")
