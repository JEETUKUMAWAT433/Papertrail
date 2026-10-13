import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient as FastAPITestClient

from app.main import create_app as _create_app


class TestClient(FastAPITestClient):
    def __init__(self, app, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        headers.setdefault("Authorization", "Bearer test-user")
        super().__init__(app, headers=headers, **kwargs)


@pytest.fixture
def study_client(tmp_path):
    app = _create_app(
        database_path=tmp_path / "study.sqlite3",
        upload_dir=tmp_path / "uploads",
        token_verifier=lambda token: token,
    )
    with TestClient(app) as client:
        yield client


def test_study_timer_survives_refresh_and_excludes_paused_time(study_client):
    started = study_client.post(
        "/api/study/sessions",
        json={"subject": "  Python  ", "notes": "  chapter 4  "},
    )
    assert started.status_code == 201
    session = started.json()
    assert session["subject"] == "Python"
    assert session["notes"] == "chapter 4"
    assert session["status"] == "active"

    time.sleep(1.05)
    paused = study_client.post(f"/api/study/sessions/{session['id']}/pause")
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"
    assert paused.json()["duration_seconds"] >= 1

    time.sleep(1.05)
    after_refresh = study_client.get("/api/study/active")
    assert after_refresh.status_code == 200
    assert after_refresh.json()["id"] == session["id"]
    assert after_refresh.json()["duration_seconds"] == paused.json()["duration_seconds"]

    resumed = study_client.post(f"/api/study/sessions/{session['id']}/resume")
    assert resumed.status_code == 200
    time.sleep(1.05)
    stopped = study_client.post(f"/api/study/sessions/{session['id']}/stop")
    assert stopped.status_code == 200
    completed = stopped.json()
    assert completed["status"] == "completed"
    assert completed["end_time"] is not None
    assert completed["duration_seconds"] >= paused.json()["duration_seconds"] + 1
    assert study_client.get("/api/study/active").json() is None


def test_study_timer_rejects_duplicate_and_invalid_transitions(study_client):
    started = study_client.post("/api/study/sessions", json={"subject": "DSA"})
    session_id = started.json()["id"]

    duplicate = study_client.post(
        "/api/study/sessions", json={"subject": "Mathematics"}
    )
    invalid_resume = study_client.post(
        f"/api/study/sessions/{session_id}/resume"
    )
    missing = study_client.post("/api/study/sessions/missing/stop")

    assert duplicate.status_code == 409
    assert invalid_resume.status_code == 409
    assert missing.status_code == 404

    paused = study_client.post(f"/api/study/sessions/{session_id}/pause")
    stopped = study_client.post(f"/api/study/sessions/{session_id}/stop")
    assert paused.status_code == 200
    assert stopped.status_code == 422
    assert study_client.get("/api/study/active").json()["status"] == "paused"


@pytest.mark.parametrize("subject", ["", "   ", "x" * 81])
def test_study_timer_rejects_invalid_subject(study_client, subject):
    response = study_client.post(
        "/api/study/sessions", json={"subject": subject}
    )

    assert response.status_code == 422
    assert study_client.get("/api/study/active").json() is None


def test_study_goal_validation_and_persistence(study_client):
    assert study_client.get("/api/study/goal").json() == {
        "daily_goal_minutes": 60
    }

    updated = study_client.put(
        "/api/study/goal", json={"daily_goal_minutes": 90}
    )
    invalid = study_client.put(
        "/api/study/goal", json={"daily_goal_minutes": 1441}
    )

    assert updated.status_code == 200
    assert study_client.get("/api/study/goal").json()["daily_goal_minutes"] == 90
    assert invalid.status_code == 422


def test_dashboard_and_history_use_saved_session_data(study_client):
    started = study_client.post(
        "/api/study/sessions",
        json={"subject": "Custom Biology", "notes": "cell division"},
    )
    session_id = started.json()["id"]
    time.sleep(1.05)
    completed = study_client.post(f"/api/study/sessions/{session_id}/stop")
    assert completed.status_code == 200

    dashboard = study_client.get(
        "/api/study/dashboard", params={"timezone_offset_minutes": -330}
    ).json()
    history = study_client.get(
        "/api/study/sessions",
        params={
            "subject": "Custom Biology",
            "from_date": datetime.now(timezone.utc).date().isoformat(),
            "to_date": (datetime.now(timezone.utc) + timedelta(days=1))
            .date()
            .isoformat(),
            "timezone_offset_minutes": 0,
        },
    )

    assert dashboard["today_seconds"] >= 1
    assert dashboard["week_seconds"] >= dashboard["today_seconds"]
    assert dashboard["month_seconds"] >= dashboard["today_seconds"]
    assert dashboard["completed_sessions"] == 1
    assert sum(day["seconds"] for day in dashboard["weekly"]) >= 1
    assert dashboard["subjects"] == [
        {"subject": "Custom Biology", "seconds": completed.json()["duration_seconds"]}
    ]
    assert history.status_code == 200
    assert len(history.json()) == 1
    assert history.json()[0]["notes"] == "cell division"


def test_study_history_validates_date_range_and_timezone(study_client):
    backwards = study_client.get(
        "/api/study/sessions",
        params={"from_date": "2026-10-12", "to_date": "2026-10-10"},
    )
    invalid_timezone = study_client.get(
        "/api/study/dashboard", params={"timezone_offset_minutes": 900}
    )

    assert backwards.status_code == 422
    assert invalid_timezone.status_code == 422


def test_study_sessions_and_goals_are_isolated_between_users(tmp_path):
    app = _create_app(
        database_path=tmp_path / "study.sqlite3",
        upload_dir=tmp_path / "uploads",
        token_verifier=lambda token: token,
    )
    first_user = TestClient(
        app, headers={"Authorization": "Bearer first-user"}
    )
    second_user = TestClient(
        app, headers={"Authorization": "Bearer second-user"}
    )

    with first_user, second_user:
        created = first_user.post(
            "/api/study/sessions",
            json={"subject": "Private subject", "notes": "first user only"},
        )
        first_user.put("/api/study/goal", json={"daily_goal_minutes": 90})
        second_user_active = second_user.get("/api/study/active")
        second_user_goal = second_user.get("/api/study/goal")
        second_user_history = second_user.get("/api/study/sessions")

    assert created.status_code == 201
    assert second_user_active.status_code == 200
    assert second_user_active.json() is None
    assert second_user_goal.json() == {"daily_goal_minutes": 60}
    assert second_user_history.json() == []
