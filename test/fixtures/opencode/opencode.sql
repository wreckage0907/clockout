-- Synthetic opencode 2 database: the tables and columns Clockout reads, plus a few neighbours.
-- Tests build an opencode.db from this script.
CREATE TABLE `session_v2` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `parent_id` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `title` text,
  `version` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE TABLE `session_message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `type` text NOT NULL,
  `seq` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
INSERT INTO session_v2 VALUES ('ses_0a1b2c3d4ffeAcmeInvoices01', 'prj_example', NULL, 'voices01', '/Users/dev/work/acme-api', 'Paginate the invoices endpoint', '2.0.32', 1792137600000, 1792138440000);
INSERT INTO session_v2 VALUES ('ses_0a1b2c3d4ffeAcmeExplore02', 'prj_example', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'xplore02', '/Users/dev/work/acme-api', 'Find the invoice queries (@explore subagent)', '2.0.32', 1792137620000, 1792137660000);
INSERT INTO session_v2 VALUES ('ses_0a1b2c3d4ffeClockoutLate03', 'prj_example', NULL, 'utlate03', '/Users/dev/code/clockout', 'New session - 2026-10-16T18:20:00.000Z', '2.0.32', 1792174800000, 1792175760000);
INSERT INTO session_v2 VALUES ('ses_0a1b2c3d4ffeAcmeOldTues04', 'prj_example', NULL, 'ldtues04', '/Users/dev/work/acme-api', 'Bump the SDK', '2.0.32', 1791871200000, 1791871500000);
INSERT INTO session_v2 VALUES ('ses_0a1b2c3d4ffeClockoutAi05', 'prj_global', NULL, 'outai05x', '/tmp/clockout-ai-AbC123/work', 'Timesheet descriptions', '2.0.32', 1792150000000, 1792150010000);
INSERT INTO session_message VALUES ('msg_0001', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'model-switched', 3, 1792137600000, 1792137600000, '{"time": {"created": 1792137600000}, "model": {"providerID": "example", "modelID": "example-model"}, "previous": null}');
INSERT INTO session_message VALUES ('msg_0002', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'user', 6, 1792137610000, 1792137610000, '{"time": {"created": 1792137610000}, "text": "Add cursor pagination to GET /invoices", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0003', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'assistant', 9, 1792137612000, 1792137612000, '{"time": {"created": 1792137612000, "completed": 1792137690000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0004', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'assistant', 12, 1792137691000, 1792137691000, '{"time": {"created": 1792137691000, "completed": 1792137760000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0005', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'idle', 15, 1792137761000, 1792137761000, '{"time": {"created": 1792137761000}, "outcome": "done"}');
INSERT INTO session_message VALUES ('msg_0006', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'synthetic', 18, 1792137900000, 1792137900000, '{"time": {"created": 1792137900000}, "text": "(context the app added)", "description": "compaction"}');
INSERT INTO session_message VALUES ('msg_0007', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'user', 21, 1792138200000, 1792138200000, '{"time": {"created": 1792138200000}, "text": "   ", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0008', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'user', 24, 1792138260000, 1792138260000, '{not json');
INSERT INTO session_message VALUES ('msg_0009', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'user', 27, 1792138320000, 1792138320000, '{"time": {"created": 1792138320000}, "text": "Now add a test for the last page", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0010', 'ses_0a1b2c3d4ffeAcmeInvoices01', 'assistant', 30, 1792138325000, 1792138325000, '{"time": {"created": 1792138325000, "completed": 1792138440000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0011', 'ses_0a1b2c3d4ffeAcmeExplore02', 'user', 3, 1792137620000, 1792137620000, '{"time": {"created": 1792137620000}, "text": "Find every query on the invoices table", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0012', 'ses_0a1b2c3d4ffeAcmeExplore02', 'assistant', 6, 1792137622000, 1792137622000, '{"time": {"created": 1792137622000, "completed": 1792137660000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0013', 'ses_0a1b2c3d4ffeClockoutLate03', 'user', 3, 1792174800000, 1792174800000, '{"time": {"created": 1792174800000}, "text": "Why does the export drop the last row?", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0014', 'ses_0a1b2c3d4ffeClockoutLate03', 'assistant', 6, 1792174805000, 1792174805000, '{"time": {"created": 1792174805000, "completed": 1792174920000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0015', 'ses_0a1b2c3d4ffeClockoutLate03', 'user', 9, 1792175700000, 1792175700000, '{"time": {"created": 1792175700000}, "text": "Fix it and add a test", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0016', 'ses_0a1b2c3d4ffeClockoutLate03', 'assistant', 12, 1792175705000, 1792175705000, '{"time": {"created": 1792175705000, "completed": 1792175760000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0017', 'ses_0a1b2c3d4ffeAcmeOldTues04', 'user', 3, 1791871200000, 1791871200000, '{"time": {"created": 1791871200000}, "text": "Bump the SDK to the latest minor", "files": [], "agents": []}');
INSERT INTO session_message VALUES ('msg_0018', 'ses_0a1b2c3d4ffeAcmeOldTues04', 'assistant', 6, 1791871203000, 1791871203000, '{"time": {"created": 1791871203000, "completed": 1791871500000}, "agent": "build", "model": {"providerID": "example", "modelID": "example-model"}, "content": [{"type": "text", "text": "(reply)"}], "finish": "stop", "cost": 0, "tokens": {"input": 10, "output": 10}}');
INSERT INTO session_message VALUES ('msg_0900', 'ses_0a1b2c3d4ffeClockoutAi05', 'user', 3, 1792150000000, 1792150000000, '{"time": {"created": 1792150000000}, "text": "(clockout prompt)", "files": [], "agents": []}');
