from django.db import models


class Candidate(models.Model):
    department = models.CharField(max_length=80, blank=True)
    roles = models.TextField(blank=True)
    first_name = models.CharField(max_length=120, blank=True)
    last_name = models.CharField(max_length=120, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=60, blank=True)
    city = models.CharField(max_length=120, blank=True)
    linkedin = models.URLField(blank=True)
    portfolio = models.URLField(blank=True)
    why_join = models.TextField(blank=True)
    answers = models.TextField(blank=True)
    resume = models.FileField(upload_to="resumes/", blank=True)
    resume_name = models.CharField(max_length=255, blank=True)
    request_id = models.CharField(max_length=120, unique=True)
    interview_status = models.CharField(max_length=80, default="Pending Setup")
    interviewer = models.CharField(max_length=120, blank=True)
    rating = models.PositiveSmallIntegerField(default=0)
    final_decision = models.CharField(max_length=80, default="Under Review")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class FormGate(models.Model):
    key = models.CharField(max_length=80, unique=True)
    is_open = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)


class AdminSession(models.Model):
    token = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
