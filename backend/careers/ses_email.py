import logging

logger = logging.getLogger(__name__)

ROLE_LABELS = {
    "content_editor": "Content Editor",
    "content_writer_upsc": "Content Writer (UPSC)",
    "upsc_strategist": "UPSC Strategist",
    "graphic_designer_canva": "Graphic Designer (Canva)",
    "uiux_designer": "UI/UX Designer",
    "video_editor_reels_yt": "Video Editor (Reels & YT)",
    "social_media_manager_ig": "Social Media Manager (Instagram)",
    "youtube_manager": "YouTube Manager",
    "hr": "HR",
    "marketing_outreach": "Marketing & Outreach",
    "management_coordination": "Management & Coordination",
    "collab_outreach": "Collaboration & Outreach",
    "tech_roles": "Technology",
}


def _is_configured():
    from django.conf import settings
    return bool(
        getattr(settings, "AWS_SES_ACCESS_KEY_ID", "")
        and getattr(settings, "AWS_SES_SECRET_ACCESS_KEY", "")
    )


def _render_admin_template(first_name, role_label):
    """Fetch the admin-managed 'career_application' template from the admin panel
    and fill its {{tokens}}. Returns (subject, html) or (None, None) if the admin
    API is unreachable — so the built-in email below is used as a fallback."""
    from django.conf import settings
    import re
    import json
    from urllib.request import urlopen, Request
    base = getattr(settings, "ADMIN_PUBLIC_API", "").rstrip("/")
    if not base:
        return None, None
    try:
        req = Request(
            f"{base}/api/public/email-template/career_application/",
            headers={"Accept": "application/json"},
        )
        with urlopen(req, timeout=6) as resp:
            if resp.status != 200:
                return None, None
            tpl = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.info("Admin template fetch failed, using built-in email: %s", exc)
        return None, None
    ctx = {
        "name": first_name or "there",
        "role": role_label or "the team",
        "careers_url": "https://tiesverse.com",
    }
    sub = lambda t: re.sub(r"{{\s*(\w+)\s*}}", lambda m: str(ctx.get(m.group(1), m.group(0))), t or "")
    subject = sub(tpl.get("subject", "")) or None
    html = sub(tpl.get("body_html", "")) or None
    return subject, html


def send_application_confirmation(to_email, first_name, department, roles):
    """Send a 'Thank you for applying' email via AWS SES. Never raises.
    Uses the admin-managed template when available, else the built-in HTML."""
    if not _is_configured():
        logger.warning("SES not configured — skipping career confirmation email to %s", to_email)
        return False

    from django.conf import settings
    import boto3

    role_label = ROLE_LABELS.get(roles, roles) if roles else department

    # Prefer the admin-managed 'career_application' template (edited in the admin
    # Email Designer). Fall back to the built-in HTML below if unreachable.
    subject, html_body = _render_admin_template(first_name, role_label)
    if not (subject and html_body):
        subject = "Thank you for applying to TiesVerse!"
        html_body = f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 0; }}
    .container {{ max-width: 580px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }}
    .header {{ background: #0f0f0f; padding: 32px 40px; }}
    .header h1 {{ color: #ffffff; font-size: 22px; margin: 0; letter-spacing: -0.3px; }}
    .header span {{ color: #f59e0b; }}
    .body {{ padding: 32px 40px; color: #333; }}
    .body h2 {{ font-size: 20px; color: #111; margin-top: 0; }}
    .body p {{ line-height: 1.7; color: #555; font-size: 15px; }}
    .role-card {{ background: #fafafa; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }}
    .role-card p {{ margin: 4px 0; font-size: 14px; color: #444; }}
    .role-card strong {{ color: #111; }}
    .footer {{ background: #f9f9f9; border-top: 1px solid #eee; padding: 20px 40px; text-align: center; }}
    .footer p {{ font-size: 12px; color: #999; margin: 0; }}
    a {{ color: #f59e0b; }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Ties<span>Verse</span></h1>
    </div>
    <div class="body">
      <h2>Thanks for applying, {first_name}!</h2>
      <p>We've received your application and our team will review it carefully. We'll be in touch if your profile is a good fit.</p>
      <div class="role-card">
        <p><strong>Department:</strong> {department}</p>
        <p><strong>Role:</strong> {role_label}</p>
      </div>
      <p>In the meantime, feel free to explore our work at <a href="https://tiesverse.com">tiesverse.com</a>.</p>
      <p>— The TiesVerse Team</p>
    </div>
    <div class="footer">
      <p>You're receiving this because you applied at tiesverse.com &nbsp;·&nbsp; <a href="https://tiesverse.com">tiesverse.com</a></p>
    </div>
  </div>
</body>
</html>
"""

    text_body = (
        f"Hi {first_name},\n\n"
        f"Thanks for applying to TiesVerse!\n\n"
        f"Department: {department}\nRole: {role_label}\n\n"
        "We've received your application and will review it carefully. "
        "We'll reach out if your profile is a good fit.\n\n"
        "— The TiesVerse Team\nhttps://tiesverse.com"
    )

    try:
        client = boto3.client(
            "ses",
            region_name=settings.AWS_SES_REGION,
            aws_access_key_id=settings.AWS_SES_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SES_SECRET_ACCESS_KEY,
        )
        client.send_email(
            Source=settings.SES_CAREERS_FROM_EMAIL,
            Destination={"ToAddresses": [to_email]},
            Message={
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {
                    "Html": {"Data": html_body, "Charset": "UTF-8"},
                    "Text": {"Data": text_body, "Charset": "UTF-8"},
                },
            },
        )
        logger.info("Career confirmation email sent to %s", to_email)
        return True
    except Exception as exc:
        logger.warning("Career SES send failed for %s: %s", to_email, exc)
        return False
