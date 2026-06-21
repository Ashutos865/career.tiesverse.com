from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="AdminSession",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("token", models.CharField(max_length=64, unique=True)),
                ("expires_at", models.DateTimeField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
        ),
        migrations.CreateModel(
            name="Candidate",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("department", models.CharField(blank=True, max_length=80)),
                ("roles", models.TextField(blank=True)),
                ("first_name", models.CharField(blank=True, max_length=120)),
                ("last_name", models.CharField(blank=True, max_length=120)),
                ("email", models.EmailField(blank=True, max_length=254)),
                ("phone", models.CharField(blank=True, max_length=60)),
                ("city", models.CharField(blank=True, max_length=120)),
                ("linkedin", models.URLField(blank=True)),
                ("portfolio", models.URLField(blank=True)),
                ("why_join", models.TextField(blank=True)),
                ("answers", models.TextField(blank=True)),
                ("resume", models.FileField(blank=True, upload_to="resumes/")),
                ("resume_name", models.CharField(blank=True, max_length=255)),
                ("request_id", models.CharField(max_length=120, unique=True)),
                ("interview_status", models.CharField(default="Pending Setup", max_length=80)),
                ("interviewer", models.CharField(blank=True, max_length=120)),
                ("rating", models.PositiveSmallIntegerField(default=0)),
                ("final_decision", models.CharField(default="Under Review", max_length=80)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="FormGate",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("key", models.CharField(max_length=80, unique=True)),
                ("is_open", models.BooleanField(default=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
        ),
    ]
