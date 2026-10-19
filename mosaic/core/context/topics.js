'use strict';

const TOPIC_IDS = ['goal', 'plan', 'file-tree', 'diff', 'test-results', 'error', 'note'];

const TOPICS = TOPIC_IDS.map((id) => Object.freeze({
  id,
  label: { goal: 'Goal', plan: 'Plan', 'file-tree': 'File Tree', diff: 'Diff', 'test-results': 'Test Results', error: 'Error', note: 'Note' }[id],
  description: {
    goal: 'The task the workspace is working toward',
    plan: 'The plan or next actions agreed across panes',
    'file-tree': 'Project file structure',
    diff: 'Code changes proposed or applied',
    'test-results': 'Test outputs and summaries',
    error: 'Errors captured from any pane',
    note: 'General context notes',
  }[id],
}));

const DEFAULT_TOPICS = Object.freeze(TOPIC_IDS);

function listTopics() {
  return [...TOPICS];
}

function getTopic(id) {
  return TOPICS.find((topic) => topic.id === id) || null;
}

function isBuiltinTopic(id) {
  return TOPIC_IDS.includes(id);
}

module.exports = { TOPICS, TOPIC_IDS, DEFAULT_TOPICS, listTopics, getTopic, isBuiltinTopic };
