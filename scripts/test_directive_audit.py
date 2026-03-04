#!/usr/bin/env python3
"""Unit tests for directive-audit.py (wq-812).

Covers:
- extract_session_data with synthetic JSONL logs
- Each check_* function with known inputs
- run_audit end-to-end with temp files
- CLI argument validation (main)

Run: python3 -m pytest scripts/test_directive_audit.py -v
  or: python3 -m unittest scripts.test_directive_audit -v
  or: python3 scripts/test_directive_audit.py
"""

import importlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Import directive-audit.py (hyphenated name requires spec loading)
_spec = importlib.util.spec_from_file_location(
    'directive_audit',
    Path(__file__).parent / 'directive-audit.py'
)
da = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(da)


class TestExtractSessionData(unittest.TestCase):
    """Tests for extract_session_data()."""

    def _write_log(self, lines):
        """Write JSONL lines to a temp file and return the path."""
        f = tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False)
        for line in lines:
            f.write(json.dumps(line) + '\n')
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_empty_log(self):
        path = self._write_log([])
        tools, text, edits = da.extract_session_data(path)
        self.assertEqual(tools, set())
        self.assertEqual(text, '')
        self.assertEqual(edits, set())

    def test_extracts_tool_names(self):
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': '/tmp/test.py'}},
                {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/home/moltbot/moltbook-mcp/index.js'}},
            ]}}
        ]
        tools, text, edits = da.extract_session_data(self._write_log(log))
        self.assertIn('Read', tools)
        self.assertIn('Edit', tools)

    def test_extracts_file_edits(self):
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Write', 'input': {'file_path': '/home/moltbot/moltbook-mcp/BRIEFING.md'}},
            ]}}
        ]
        _, _, edits = da.extract_session_data(self._write_log(log))
        self.assertIn('/home/moltbot/moltbook-mcp/briefing.md', edits)

    def test_extracts_commands_as_text(self):
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'git push origin master'}},
            ]}}
        ]
        _, text, _ = da.extract_session_data(self._write_log(log))
        self.assertIn('git push', text)

    def test_extracts_text_blocks(self):
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'text', 'text': 'I will update the work-queue.json with wq-100 done'},
            ]}}
        ]
        _, text, _ = da.extract_session_data(self._write_log(log))
        self.assertIn('work-queue.json', text)
        self.assertIn('wq-100', text)

    def test_ignores_non_assistant_messages(self):
        log = [
            {'type': 'user', 'message': {'content': [
                {'type': 'tool_use', 'name': 'ShouldNotAppear', 'input': {}},
            ]}}
        ]
        tools, _, _ = da.extract_session_data(self._write_log(log))
        self.assertEqual(tools, set())

    def test_handles_malformed_json_lines(self):
        f = tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False)
        f.write('{"type":"assistant","message":{"content":[{"type":"text","text":"good"}]}}\n')
        f.write('not json at all\n')
        f.write('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}\n')
        f.close()
        self.addCleanup(os.unlink, f.name)
        tools, text, _ = da.extract_session_data(f.name)
        self.assertIn('Read', tools)
        self.assertIn('good', text)

    def test_extracts_path_from_input(self):
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Glob', 'input': {'path': '/home/moltbot/moltbook-mcp/hooks/'}},
            ]}}
        ]
        _, _, edits = da.extract_session_data(self._write_log(log))
        self.assertIn('/home/moltbot/moltbook-mcp/hooks/', edits)


class TestCheckFunctions(unittest.TestCase):
    """Tests for each check_* function."""

    def test_structural_change_detects_heartbeat(self):
        edits = {'heartbeat.sh'}
        ok, _ = da.check_structural_change(set(), '', edits)
        self.assertTrue(ok)

    def test_structural_change_detects_hooks_dir(self):
        edits = {'/home/moltbot/moltbook-mcp/hooks/pre-session/01-test.sh'}
        ok, _ = da.check_structural_change(set(), '', edits)
        self.assertTrue(ok)

    def test_structural_change_negative(self):
        edits = {'readme.md', 'package.json'}
        ok, reason = da.check_structural_change(set(), '', edits)
        self.assertFalse(ok)
        self.assertIn('No edits', reason)

    def test_commit_and_push_detects_push(self):
        ok, _ = da.check_commit_and_push(set(), 'running git push origin master', set())
        self.assertTrue(ok)

    def test_commit_and_push_detects_commit(self):
        ok, _ = da.check_commit_and_push(set(), 'git commit -m "test"', set())
        self.assertTrue(ok)

    def test_commit_and_push_negative(self):
        ok, _ = da.check_commit_and_push(set(), 'just reading files', set())
        self.assertFalse(ok)

    def test_reflection_summary_detects_markers(self):
        for marker in ['what i improved', 'still neglecting', 'session summary']:
            ok, _ = da.check_reflection_summary(set(), f'here is {marker} text', set())
            self.assertTrue(ok, f'Failed for marker: {marker}')

    def test_reflection_summary_negative(self):
        ok, _ = da.check_reflection_summary(set(), 'just building code', set())
        self.assertFalse(ok)

    def test_platform_engagement_detects_tools(self):
        ok, _ = da.check_platform_engagement(
            {'mcp__moltbook__moltbook_search'}, '', set())
        self.assertTrue(ok)

    def test_platform_engagement_detects_platform_names(self):
        ok, _ = da.check_platform_engagement(set(), 'posted on chatr about topic', set())
        self.assertTrue(ok)

    def test_platform_engagement_negative(self):
        ok, _ = da.check_platform_engagement(set(), 'building code', set())
        self.assertFalse(ok)

    def test_platform_discovery_detects_webfetch(self):
        ok, _ = da.check_platform_discovery({'WebFetch'}, '', set())
        self.assertTrue(ok)

    def test_platform_discovery_detects_service_eval(self):
        ok, _ = da.check_platform_discovery(set(), 'checking services.json for new endpoint', set())
        self.assertTrue(ok)

    def test_platform_discovery_negative(self):
        ok, _ = da.check_platform_discovery(set(), 'nothing relevant', set())
        self.assertFalse(ok)

    def test_queue_consumption_detects_wq_edit(self):
        ok, _ = da.check_queue_consumption(set(), '', {'work-queue.json'})
        self.assertTrue(ok)

    def test_queue_consumption_detects_wq_ref(self):
        ok, _ = da.check_queue_consumption(set(), 'wq-100 is now done', set())
        self.assertTrue(ok)

    def test_queue_consumption_negative(self):
        ok, _ = da.check_queue_consumption(set(), 'no queue work', set())
        self.assertFalse(ok)

    def test_ecosystem_adoption_detects_tools(self):
        ok, _ = da.check_ecosystem_adoption(
            {'mcp__moltbook__ctxly_remember'}, '', set())
        self.assertTrue(ok)

    def test_ecosystem_adoption_detects_text(self):
        ok, _ = da.check_ecosystem_adoption(set(), 'using kv_set for storage', set())
        self.assertTrue(ok)

    def test_ecosystem_adoption_negative(self):
        ok, _ = da.check_ecosystem_adoption(set(), 'local work only', set())
        self.assertFalse(ok)

    def test_briefing_update(self):
        ok, _ = da.check_briefing_update(set(), '', {'briefing.md'})
        self.assertTrue(ok)
        ok, _ = da.check_briefing_update(set(), '', {'readme.md'})
        self.assertFalse(ok)

    def test_directive_update(self):
        ok, _ = da.check_directive_update(set(), '', {'directives.json'})
        self.assertTrue(ok)
        ok, _ = da.check_directive_update(set(), '', {'other.json'})
        self.assertFalse(ok)


class TestRunAudit(unittest.TestCase):
    """End-to-end tests for run_audit()."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_log(self, lines):
        path = os.path.join(self.tmpdir, 'session.jsonl')
        with open(path, 'w') as f:
            for line in lines:
                f.write(json.dumps(line) + '\n')
        return path

    def _write_directives(self, data=None):
        path = os.path.join(self.tmpdir, 'directives.json')
        if data is None:
            data = {'directives': [], 'questions': []}
        with open(path, 'w') as f:
            json.dump(data, f)
        return path

    def test_b_session_audit(self):
        """B session with git push + work-queue edit should follow commit-and-push + queue-consumption."""
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'git commit -m "test" && git push'}},
                {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/home/moltbot/moltbook-mcp/work-queue.json'}},
                {'type': 'text', 'text': 'Updated wq-100 to done in work-queue.json'},
            ]}},
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'mcp__moltbook__ctxly_remember', 'input': {}},
            ]}},
        ]
        log_path = self._write_log(log)
        dir_path = self._write_directives()

        da.run_audit(log_path, 'B', 1000, dir_path)

        with open(dir_path) as f:
            data = json.load(f)
        metrics = data['compliance']['metrics']

        # B-applicable directives: commit-and-push, queue-consumption, ecosystem-adoption
        self.assertGreater(metrics['commit-and-push']['followed'], 0)
        self.assertGreater(metrics['queue-consumption']['followed'], 0)
        self.assertGreater(metrics['ecosystem-adoption']['followed'], 0)

    def test_r_session_audit(self):
        """R session with reflection markers should follow reflection-summary."""
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'text', 'text': 'Session summary: what i improved this session is the hook system'},
                {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/home/moltbot/moltbook-mcp/heartbeat.sh'}},
                {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'git commit -m "r-session" && git push'}},
                {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/home/moltbot/moltbook-mcp/BRIEFING.md'}},
                {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/home/moltbot/moltbook-mcp/directives.json'}},
            ]}},
        ]
        log_path = self._write_log(log)
        dir_path = self._write_directives()

        da.run_audit(log_path, 'R', 1001, dir_path)

        with open(dir_path) as f:
            data = json.load(f)
        metrics = data['compliance']['metrics']

        self.assertGreater(metrics['structural-change']['followed'], 0)
        self.assertGreater(metrics['reflection-summary']['followed'], 0)
        self.assertGreater(metrics['commit-and-push']['followed'], 0)
        self.assertGreater(metrics['briefing-update']['followed'], 0)
        self.assertGreater(metrics['directive-update']['followed'], 0)

    def test_e_session_audit(self):
        """E session with platform engagement should follow platform-engagement."""
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'mcp__moltbook__moltbook_search', 'input': {'query': 'test'}},
                {'type': 'text', 'text': 'Browsing chatr for new discussions'},
            ]}},
        ]
        log_path = self._write_log(log)
        dir_path = self._write_directives()

        da.run_audit(log_path, 'E', 1002, dir_path)

        with open(dir_path) as f:
            data = json.load(f)
        metrics = data['compliance']['metrics']

        self.assertGreater(metrics['platform-engagement']['followed'], 0)

    def test_preserves_existing_compliance_data(self):
        """run_audit should increment, not replace, existing counts."""
        initial = {
            'directives': [],
            'compliance': {
                'metrics': {
                    'commit-and-push': {
                        'followed': 5, 'ignored': 2,
                        'last_ignored_reason': '', 'last_session': 999,
                        'last_applicable_session': 999, 'history': [],
                    }
                }
            }
        }
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'git push'}},
            ]}},
        ]
        log_path = self._write_log(log)
        dir_path = self._write_directives(initial)

        da.run_audit(log_path, 'B', 1003, dir_path)

        with open(dir_path) as f:
            data = json.load(f)
        self.assertEqual(data['compliance']['metrics']['commit-and-push']['followed'], 6)
        self.assertEqual(data['compliance']['metrics']['commit-and-push']['last_session'], 1003)

    def test_history_capped_at_10(self):
        """History array should never exceed 10 entries."""
        initial = {
            'directives': [],
            'compliance': {
                'metrics': {
                    'commit-and-push': {
                        'followed': 10, 'ignored': 0,
                        'last_ignored_reason': '', 'last_session': 999,
                        'last_applicable_session': 999,
                        'history': [{'session': i, 'result': 'followed'} for i in range(990, 1000)],
                    }
                }
            }
        }
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'git push'}},
            ]}},
        ]
        log_path = self._write_log(log)
        dir_path = self._write_directives(initial)

        da.run_audit(log_path, 'B', 1010, dir_path)

        with open(dir_path) as f:
            data = json.load(f)
        history = data['compliance']['metrics']['commit-and-push']['history']
        self.assertLessEqual(len(history), 10)
        self.assertEqual(history[-1]['session'], 1010)

    def test_empty_directives_file_exits_2(self):
        """Empty directives file should cause exit code 2."""
        log_path = self._write_log([])
        dir_path = os.path.join(self.tmpdir, 'empty.json')
        with open(dir_path, 'w') as f:
            f.write('')

        with self.assertRaises(SystemExit) as cm:
            da.run_audit(log_path, 'B', 1004, dir_path)
        self.assertEqual(cm.exception.code, 2)

    def test_non_applicable_directives_not_counted(self):
        """Directives not applicable to the mode should not appear in results."""
        log = [
            {'type': 'assistant', 'message': {'content': [
                {'type': 'text', 'text': 'what i improved today is nothing'},
            ]}},
        ]
        log_path = self._write_log(log)
        dir_path = self._write_directives()

        # reflection-summary is R-only, so running B session shouldn't count it
        da.run_audit(log_path, 'B', 1005, dir_path)

        with open(dir_path) as f:
            data = json.load(f)
        metrics = data['compliance']['metrics']
        # reflection-summary should not have been counted (it's R-only)
        if 'reflection-summary' in metrics:
            self.assertEqual(metrics['reflection-summary']['followed'], 0)
            self.assertEqual(metrics['reflection-summary']['ignored'], 0)


class TestCLI(unittest.TestCase):
    """Tests for main() CLI argument handling."""

    def test_wrong_arg_count_exits_1(self):
        """Calling with wrong number of args should exit 1."""
        old_argv = sys.argv
        try:
            sys.argv = ['directive-audit.py']
            with self.assertRaises(SystemExit) as cm:
                da.main()
            self.assertEqual(cm.exception.code, 1)
        finally:
            sys.argv = old_argv

    def test_missing_log_file_exits_1(self):
        """Calling with a nonexistent log file should exit 1."""
        old_argv = sys.argv
        try:
            sys.argv = ['directive-audit.py', '/nonexistent/log.jsonl', 'B', '1000', '/tmp/d.json']
            with self.assertRaises(SystemExit) as cm:
                da.main()
            self.assertEqual(cm.exception.code, 1)
        finally:
            sys.argv = old_argv


if __name__ == '__main__':
    unittest.main()
