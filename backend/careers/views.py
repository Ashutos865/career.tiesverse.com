import base64
import json
import mimetypes
import re
import uuid
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .models import AdminSession, Candidate, FormGate
from .providers import get_data_provider


CATEGORY_KEYS = ["Tech", "Content", "Media", "Operations"]
CATEGORY_POSITIONS = {
    "Content": ["content_editor", "content_writer_upsc", "upsc_strategist", "graphic_designer_canva", "uiux_designer"],
    "Media": ["video_editor_reels_yt", "social_media_manager_ig", "youtube_manager"],
    "Operations": ["hr", "marketing_outreach", "management_coordination", "collab_outreach"],
    "Tech": ["tech_roles"],
}
DEFAULT_GATE_KEYS = [
    "Tech",
    "Content",
    "Media",
    "Operations",
    "content_editor",
    "content_writer_upsc",
    "upsc_strategist",
    "graphic_designer_canva",
    "uiux_designer",
    "video_editor_reels_yt",
    "social_media_manager_ig",
    "youtube_manager",
    "hr",
    "marketing_outreach",
    "management_coordination",
    "collab_outreach",
    "tech_roles",
]


def static_page(request, page):
    safe_page = Path(page).name
    path = settings.FRONTEND_DIR / safe_page
    if not path.exists():
        raise Http404
    content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return FileResponse(path.open("rb"), content_type=content_type)


@csrf_exempt
def api_entrypoint(request):
    if request.method == "OPTIONS":
        return HttpResponse("")

    try:
        if settings.DATA_PROVIDER in {"appscript", "cloudflare"}:
            provider = get_data_provider()
            if request.method == "POST":
                payload = json.loads(request.body.decode("utf-8") or "{}")
                return JsonResponse(provider.post(payload))
            return action_response(request.GET, provider.get(request.GET))

        if request.method == "POST":
            payload = json.loads(request.body.decode("utf-8") or "{}")
            data = handle_post(payload, request)
            return JsonResponse(data)

        params = request.GET
        action = (params.get("action") or "GET_CANDIDATES").strip() or "GET_CANDIDATES"
        data = handle_get(action, params)
        return action_response(params, data)
    except Exception as exc:
        return action_response(request.GET, {"status": "error", "message": str(exc)}, status=500)


def action_response(params, data, status=200):
    callback = (params.get("callback") or "").strip()
    if callback and re.match(r"^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[0-9A-Za-z_$]+)*$", callback):
        return HttpResponse(f"{callback}({json.dumps(data)});", status=status, content_type="application/javascript")
    return JsonResponse(data, status=status)


def resume_download(request, row_id):
    if settings.DATA_PROVIDER != "cloudflare":
        raise Http404
    data = get_data_provider().get({"action": "GET_RESUME", "row": row_id})
    if data.get("status") != "success":
        raise Http404

    filename = str(data.get("resume_name") or "resume.pdf")
    content = data.get("content")
    if not isinstance(content, bytes):
        raise Http404
    content_type = str(data.get("content_type") or "application/octet-stream")

    response = HttpResponse(content, content_type=content_type)
    response["Content-Disposition"] = f'inline; filename="{filename}"'
    return response


def handle_get(action, params):
    if action == "ADMIN_LOGIN":
        if (params.get("password") or "") != settings.ADMIN_PASSWORD:
            return {"status": "error", "message": "INVALID_PASSWORD"}
        session = issue_admin_session()
        return {"status": "success", "token": session.token, "expires_at": session.expires_at.isoformat()}

    if action == "ADMIN_CHECK":
        return {"status": "success" if validate_admin_session(params.get("token")) else "UNAUTHORIZED"}

    if action in {"GET_CANDIDATES", "GET_FORM_GATES"}:
        if not validate_admin_session(params.get("token")):
            return {"status": "UNAUTHORIZED"}

    if action == "GET_CANDIDATES":
        return {"status": "success", "data": [serialize_candidate(c) for c in Candidate.objects.all()]}

    if action == "GET_FORM_GATES":
        return {"status": "success", "gates": read_form_gates()}

    if action == "GET_PUBLIC_FORM_GATES":
        return {"status": "success", "gates": read_form_gates()}

    if action == "FORM_STATUS":
        department = (params.get("department") or "").strip()
        email = normalize_email(params.get("email"))
        phone = normalize_phone(params.get("phone"))
        return {
            "status": "success",
            "open": is_form_open(department) if department else True,
            "duplicate": has_recent_duplicate(department, email, phone) if department else False,
            "department": department,
        }

    if action == "CHECK_REQUEST":
        request_id = (params.get("request_id") or "").strip()
        if not request_id:
            return {"status": "error", "message": "Missing request_id"}
        return {"status": "success", "found": Candidate.objects.filter(request_id=request_id).exists()}

    return {"status": "error", "message": "Unknown action"}


def handle_post(data, request):
    action = data.get("action")

    if action == "SET_FORM_GATES":
        if not validate_admin_session(data.get("token")):
            return {"status": "UNAUTHORIZED"}
        write_form_gates(normalize_gate_hierarchy(data.get("gates") or {}))
        return {"status": "success"}

    if action == "UPDATE_ROW":
        if not validate_admin_session(data.get("token")):
            return {"status": "UNAUTHORIZED"}
        candidate = get_object_or_404(Candidate, id=int(data.get("row") or 0))
        candidate.interview_status = str(data.get("interview_status") or "")
        candidate.interviewer = str(data.get("interviewer") or "")
        candidate.rating = int(data.get("rating") or 0)
        candidate.final_decision = str(data.get("final_decision") or "Under Review")
        candidate.save(update_fields=["interview_status", "interviewer", "rating", "final_decision"])
        return {"status": "success", "message": "Updated"}

    if action == "CREATE":
        return create_candidate(data, request)

    return {"status": "error", "message": "Unknown action"}


def create_candidate(data, request):
    department = str(data.get("department") or "").strip()
    email = normalize_email(data.get("email"))
    phone = normalize_phone(data.get("phone"))
    request_id = str(data.get("request_id") or f"req_{uuid.uuid4().hex}").strip()

    if department and not is_form_open(department):
        return {"status": "CLOSED"}
    if department and has_recent_duplicate(department, email, phone):
        return {"status": "DUPLICATE_30D"}

    candidate, created = Candidate.objects.get_or_create(
        request_id=request_id,
        defaults={
            "department": department,
            "roles": str(data.get("roles") or ""),
            "first_name": str(data.get("first_name") or ""),
            "last_name": str(data.get("last_name") or ""),
            "email": str(data.get("email") or ""),
            "phone": str(data.get("phone") or ""),
            "city": str(data.get("city") or ""),
            "linkedin": str(data.get("linkedin") or ""),
            "portfolio": str(data.get("portfolio") or ""),
            "why_join": str(data.get("why_join") or ""),
            "answers": stringify_answers(data.get("answers")),
            "resume_name": str(data.get("resume_name") or ""),
        },
    )

    if created:
        save_resume(candidate, data)
    return {"status": "success"}


def issue_admin_session():
    expires_at = timezone.now() + timedelta(days=settings.ADMIN_SESSION_DAYS)
    return AdminSession.objects.create(token=uuid.uuid4().hex, expires_at=expires_at)


def validate_admin_session(token):
    value = str(token or "").strip()
    if not value:
        return False
    AdminSession.objects.filter(expires_at__lte=timezone.now()).delete()
    return AdminSession.objects.filter(token=value, expires_at__gt=timezone.now()).exists()


def read_form_gates():
    gates = {key: True for key in DEFAULT_GATE_KEYS}
    for gate in FormGate.objects.all():
        gates[gate.key] = gate.is_open
    return normalize_gate_hierarchy(gates)


def write_form_gates(gates):
    for key, is_open in gates.items():
        FormGate.objects.update_or_create(key=key, defaults={"is_open": bool(is_open)})


def normalize_gate_hierarchy(incoming):
    merged = {key: True for key in DEFAULT_GATE_KEYS}
    merged.update({str(key): value is not False for key, value in (incoming or {}).items()})

    for category in CATEGORY_KEYS:
        positions = CATEGORY_POSITIONS.get(category, [])
        if merged.get(category) is False:
            for position in positions:
                merged[position] = False
            continue
        if any(merged.get(position) is not False for position in positions):
            merged[category] = True

    return {key: merged.get(key) is not False for key in DEFAULT_GATE_KEYS}


def is_form_open(department):
    gates = read_form_gates()
    return gates.get(department, True) is not False


def has_recent_duplicate(department, email, phone):
    if not email and not phone:
        return False
    since = timezone.now() - timedelta(days=settings.DEDUP_WINDOW_DAYS)
    qs = Candidate.objects.filter(department=department, created_at__gte=since)
    if email and qs.filter(email__iexact=email).exists():
        return True
    if phone:
        for candidate_phone in qs.values_list("phone", flat=True):
            if normalize_phone(candidate_phone) == phone:
                return True
    return False


def stringify_answers(value):
    if not isinstance(value, list):
        return str(value or "")
    lines = []
    for item in value:
        q = str((item or {}).get("q") or "").strip()
        a = str((item or {}).get("a") or "").strip()
        if q or a:
            lines.append(f"{q}\n-> {a}".strip())
    return "\n\n".join(lines)


def save_resume(candidate, data):
    resume_data = str(data.get("resume_data") or "")
    resume_name = str(data.get("resume_name") or "").strip()
    if not resume_data or not resume_name:
        return
    raw = resume_data.split(",", 1)[1] if "," in resume_data else resume_data
    try:
        decoded = base64.b64decode(raw)
    except Exception:
        return
    clean_name = re.sub(r'[\\/:*?"<>|]+', "_", resume_name)[:120] or "resume.pdf"
    candidate.resume.save(clean_name, ContentFile(decoded), save=True)


def serialize_candidate(candidate):
    resume_link = ""
    if candidate.resume:
        resume_link = f"{settings.MEDIA_URL}{candidate.resume.name}"
    return {
        "timestamp": candidate.created_at.isoformat(),
        "row_index": candidate.id,
        "department": candidate.department,
        "roles": candidate.roles,
        "first_name": candidate.first_name,
        "last_name": candidate.last_name,
        "email": candidate.email,
        "phone": candidate.phone,
        "city": candidate.city,
        "linkedin": candidate.linkedin,
        "portfolio": candidate.portfolio,
        "why_join": candidate.why_join,
        "answers": candidate.answers,
        "resume_link": resume_link,
        "interview_status": candidate.interview_status,
        "interviewer": candidate.interviewer,
        "rating": candidate.rating,
        "final_decision": candidate.final_decision,
    }


def normalize_email(value):
    return str(value or "").strip().lower()


def normalize_phone(value):
    return re.sub(r"[^\d+]", "", str(value or ""))
