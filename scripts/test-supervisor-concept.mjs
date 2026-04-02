import assert from 'node:assert/strict';

import { buildSupervisorConceptReply, looksLikeStatusQuestion } from '../src/lib/supervisor-concept.ts';

assert.equal(looksLikeStatusQuestion('What is the team doing right now?'), true);
assert.equal(looksLikeStatusQuestion('should we start planning'), true);
assert.equal(looksLikeStatusQuestion('Build a small todo app'), false);
assert.equal(looksLikeStatusQuestion('make a landing page with two sections'), false);

const updatedReply = buildSupervisorConceptReply('Build a tiny one-file page', true);
assert.match(updatedReply, /Concept captured/i);
assert.match(updatedReply, /start planning/i);

const statusReply = buildSupervisorConceptReply('Build a tiny one-file page', false);
assert.match(statusReply, /No run is active yet/i);
assert.match(statusReply, /Current concept: Build a tiny one-file page/i);

console.log('supervisor concept checks passed');
