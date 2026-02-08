"""Tests for directive-enrichment.py compute_enrichment()."""

import pytest
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

# Import the module with a hyphen in its name
_spec = spec_from_file_location(
    "directive_enrichment",
    Path(__file__).parent / "directive-enrichment.py",
)
_mod = module_from_spec(_spec)
_spec.loader.exec_module(_mod)
compute_enrichment = _mod.compute_enrichment


# --- Empty / no-match cases ---


def test_empty_queue():
    result = compute_enrichment({"directives": []}, {"queue": []})
    assert result == {}


def test_no_blocked_items():
    """Non-blocked items should never appear in enrichment."""
    directives = {"directives": [{"id": "d001", "queue_item": "wq-100"}]}
    queue = {"queue": [{"id": "wq-100", "status": "pending", "title": "Some task"}]}
    result = compute_enrichment(directives, queue)
    assert result == {}


def test_blocked_item_no_directive_link():
    """Blocked items without a matching directive are excluded."""
    directives = {"directives": [{"id": "d001", "queue_item": "wq-999"}]}
    queue = {"queue": [{"id": "wq-100", "status": "blocked", "title": "Unrelated task"}]}
    result = compute_enrichment(directives, queue)
    assert result == {}


# --- Basic matching via queue_item field ---


def test_blocked_item_matched_by_queue_item():
    directives = {
        "directives": [
            {
                "id": "d010",
                "queue_item": "wq-200",
                "status": "active",
                "notes": "Progress in s1100 and s1150. Continued work on credential rotation flow.",
            }
        ]
    }
    queue = {"queue": [{"id": "wq-200", "status": "blocked", "title": "Blocked task"}]}
    result = compute_enrichment(directives, queue)
    assert "wq-200" in result
    assert result["wq-200"]["directive_id"] == "d010"
    assert result["wq-200"]["directive_status"] == "active"
    assert result["wq-200"]["last_activity_session"] == 1150
    assert result["wq-200"]["has_recent_notes"] is True


# --- Matching via directive id in title ---


def test_blocked_item_matched_by_title_containing_directive_id():
    directives = {
        "directives": [
            {
                "id": "d045",
                "status": "in-progress",
                "notes": "Worked on in s900",
            }
        ]
    }
    queue = {
        "queue": [
            {
                "id": "wq-300",
                "status": "blocked",
                "title": "Regenerate credentials (d045)",
            }
        ]
    }
    result = compute_enrichment(directives, queue)
    assert "wq-300" in result
    assert result["wq-300"]["directive_id"] == "d045"
    assert result["wq-300"]["last_activity_session"] == 900


# --- Session number extraction ---


def test_session_numbers_from_s_prefix():
    directives = {
        "directives": [
            {
                "id": "d020",
                "queue_item": "wq-400",
                "status": "active",
                "notes": "Started in s800, continued s850, latest s912",
            }
        ]
    }
    queue = {"queue": [{"id": "wq-400", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-400"]["last_activity_session"] == 912


def test_session_numbers_from_r_prefix():
    directives = {
        "directives": [
            {
                "id": "d030",
                "queue_item": "wq-500",
                "status": "active",
                "notes": "Decomposed in R#210, updated R#215",
            }
        ]
    }
    queue = {"queue": [{"id": "wq-500", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-500"]["last_activity_session"] == 215


def test_mixed_session_and_r_numbers():
    directives = {
        "directives": [
            {
                "id": "d040",
                "queue_item": "wq-600",
                "status": "active",
                "notes": "From s1000, refined in R#1200",
            }
        ]
    }
    queue = {"queue": [{"id": "wq-600", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-600"]["last_activity_session"] == 1200


def test_no_session_numbers_falls_back_to_acked_session():
    directives = {
        "directives": [
            {
                "id": "d050",
                "queue_item": "wq-700",
                "status": "active",
                "notes": "Short note",
                "acked_session": 750,
            }
        ]
    }
    queue = {"queue": [{"id": "wq-700", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-700"]["last_activity_session"] == 750


def test_no_session_numbers_no_acked_session_returns_zero():
    directives = {
        "directives": [
            {
                "id": "d060",
                "queue_item": "wq-800",
                "status": "pending",
                "notes": "Brief",
            }
        ]
    }
    queue = {"queue": [{"id": "wq-800", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-800"]["last_activity_session"] == 0


# --- has_recent_notes threshold ---


def test_short_notes_not_recent():
    directives = {
        "directives": [
            {
                "id": "d070",
                "queue_item": "wq-900",
                "status": "active",
                "notes": "Short",  # len=5, below 50
            }
        ]
    }
    queue = {"queue": [{"id": "wq-900", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-900"]["has_recent_notes"] is False


def test_long_notes_is_recent():
    directives = {
        "directives": [
            {
                "id": "d080",
                "queue_item": "wq-1000",
                "status": "active",
                "notes": "A" * 51,
            }
        ]
    }
    queue = {"queue": [{"id": "wq-1000", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-1000"]["has_recent_notes"] is True


# --- Edge cases: missing fields ---


def test_directive_missing_notes_field():
    directives = {
        "directives": [
            {
                "id": "d090",
                "queue_item": "wq-1100",
                "status": "active",
                # no "notes" key
            }
        ]
    }
    queue = {"queue": [{"id": "wq-1100", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-1100"]["last_activity_session"] == 0
    assert result["wq-1100"]["has_recent_notes"] is False


def test_directive_missing_status_field():
    directives = {
        "directives": [
            {
                "id": "d100",
                "queue_item": "wq-1200",
                "notes": "s999 progress",
                # no "status" key
            }
        ]
    }
    queue = {"queue": [{"id": "wq-1200", "status": "blocked", "title": "Task"}]}
    result = compute_enrichment(directives, queue)
    assert result["wq-1200"]["directive_status"] is None
    assert result["wq-1200"]["last_activity_session"] == 999


def test_queue_item_missing_title():
    """Items without titles shouldn't crash the title-matching loop."""
    directives = {"directives": [{"id": "d110", "status": "active", "notes": "s500"}]}
    queue = {"queue": [{"id": "wq-1300", "status": "blocked"}]}  # no title
    result = compute_enrichment(directives, queue)
    # No match since no queue_item link and title is missing
    assert result == {}


def test_missing_directives_key():
    result = compute_enrichment({}, {"queue": [{"id": "wq-1", "status": "blocked", "title": "x"}]})
    assert result == {}


def test_missing_queue_key():
    result = compute_enrichment({"directives": [{"id": "d1"}]}, {})
    assert result == {}


# --- Multiple items ---


def test_multiple_blocked_items_some_matched():
    directives = {
        "directives": [
            {"id": "d200", "queue_item": "wq-A", "status": "active", "notes": "s1000"},
            {"id": "d201", "queue_item": "wq-C", "status": "done", "notes": "s1100"},
        ]
    }
    queue = {
        "queue": [
            {"id": "wq-A", "status": "blocked", "title": "Task A"},
            {"id": "wq-B", "status": "blocked", "title": "Task B (no directive)"},
            {"id": "wq-C", "status": "blocked", "title": "Task C"},
            {"id": "wq-D", "status": "pending", "title": "Task D (not blocked)"},
        ]
    }
    result = compute_enrichment(directives, queue)
    assert set(result.keys()) == {"wq-A", "wq-C"}
    assert result["wq-A"]["directive_id"] == "d200"
    assert result["wq-C"]["directive_id"] == "d201"
