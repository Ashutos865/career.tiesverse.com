from django.conf import settings
from django.conf.urls.static import static
from django.urls import path

from careers import views


urlpatterns = [
    path("", views.static_page, {"page": "index.html"}, name="home"),
    path("admin.html", views.static_page, {"page": "admin.html"}, name="admin-page"),
    path("tech-portal.html", views.static_page, {"page": "tech-portal.html"}, name="tech-portal"),
    path("content-portal.html", views.static_page, {"page": "content-portal.html"}, name="content-portal"),
    path("hr-portal.html", views.static_page, {"page": "hr-portal.html"}, name="hr-portal"),
    path("youtube-portal.html", views.static_page, {"page": "youtube-portal.html"}, name="youtube-portal"),
    path("tv-config.js", views.static_page, {"page": "tv-config.js"}, name="tv-config"),
    path("tv-guard.js", views.static_page, {"page": "tv-guard.js"}, name="tv-guard"),
    path("api/", views.api_entrypoint, name="career-api"),
    path("api/resume/<int:row_id>/", views.resume_download, name="resume-download"),
]

urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
urlpatterns += [path("<path:page>", views.static_page, name="static-page")]
