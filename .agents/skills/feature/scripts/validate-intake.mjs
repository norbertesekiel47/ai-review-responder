#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const intakePath = process.argv[2];
if (!intakePath) {
  console.error('usage: validate-intake.mjs <intake-path>');
  process.exit(2);
}

const requiredKeys = [
  'version',
  'size',
  'risk',
  'risk_reasons',
  'surface',
  'db_touching',
  'goal',
  'non_goals',
  'user_visible_behavior',
  'invariants',
  'edge_cases',
  'existing_patterns_to_follow',
  'test_seams',
  'allowed_edit_surface',
  'tests_to_add',
  'verification_commands',
  'estimated_prod_lines',
  'estimated_test_lines',
  'dependencies_added',
  'rollback_plan',
  'observability',
  'required_approvals',
  'open_questions',
];

const arrayKeys = [
  'risk_reasons',
  'non_goals',
  'user_visible_behavior',
  'invariants',
  'edge_cases',
  'existing_patterns_to_follow',
  'test_seams',
  'allowed_edit_surface',
  'tests_to_add',
  'verification_commands',
  'dependencies_added',
  'observability',
  'required_approvals',
  'open_questions',
];

const approvalNames = new Set([
  'commit',
  'push',
  'pull_request',
  'merge',
  'staging_deploy',
  'production_deploy',
  'remote_migration',
  'production_flag_flip',
  'worktree_cleanup',
]);

const errors = [];
let intake;

try {
  intake = JSON.parse(readFileSync(resolve(intakePath), 'utf8'));
} catch (error) {
  console.error(`intake validation failed: ${error.message}`);
  process.exit(1);
}

if (!intake || typeof intake !== 'object' || Array.isArray(intake)) {
  errors.push('intake must be one JSON object');
} else {
  const actualKeys = Object.keys(intake);
  for (const key of requiredKeys) {
    if (!actualKeys.includes(key)) errors.push(`missing required field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!requiredKeys.includes(key)) errors.push(`unknown field: ${key}`);
  }

  if (intake.version !== 1) errors.push('version must equal 1');
  if (!['trivial', 'small', 'standard', 'epic'].includes(intake.size)) {
    errors.push('size must be trivial, small, standard, or epic');
  }
  if (!['normal', 'high'].includes(intake.risk)) {
    errors.push('risk must be normal or high');
  }
  if (!['ui', 'backend', 'mixed'].includes(intake.surface)) {
    errors.push('surface must be ui, backend, or mixed');
  }
  if (typeof intake.db_touching !== 'boolean') {
    errors.push('db_touching must be boolean');
  }
  if (typeof intake.goal !== 'string' || intake.goal.trim().length === 0) {
    errors.push('goal must be a non-empty string');
  }
  if (typeof intake.rollback_plan !== 'string') {
    errors.push('rollback_plan must be a string');
  }

  for (const key of arrayKeys) {
    if (!Array.isArray(intake[key])) {
      errors.push(`${key} must be an array`);
      continue;
    }
    if (intake[key].some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      errors.push(`${key} must contain only non-empty strings`);
    }
    if (new Set(intake[key]).size !== intake[key].length) {
      errors.push(`${key} must not contain duplicates`);
    }
  }

  for (const key of ['estimated_prod_lines', 'estimated_test_lines']) {
    if (!Number.isInteger(intake[key]) || intake[key] < 0) {
      errors.push(`${key} must be a non-negative integer`);
    }
  }

  if (intake.risk === 'high' && intake.risk_reasons?.length === 0) {
    errors.push('risk_reasons must be non-empty when risk is high');
  }
  if ((intake.db_touching || intake.risk === 'high') && !intake.rollback_plan?.trim()) {
    errors.push('rollback_plan is required for db_touching or high-risk work');
  }
  if (intake.open_questions?.length > 0) {
    errors.push('open_questions must be empty before setup');
  }

  if (intake.size !== 'epic') {
    if (intake.allowed_edit_surface?.length === 0) {
      errors.push('allowed_edit_surface must be non-empty for implementation work');
    }
    const degenerateGlobs = new Set(['*', '**', '**/*']);
    for (const glob of intake.allowed_edit_surface ?? []) {
      if (degenerateGlobs.has(glob.trim())) {
        errors.push(`allowed_edit_surface contains a degenerate glob: ${glob}`);
      }
    }
    if (
      intake.tests_to_add?.length === 0 &&
      intake.verification_commands?.length === 0
    ) {
      errors.push('declare tests_to_add or deterministic verification_commands');
    }
    if (intake.tests_to_add?.length > 0 && intake.test_seams?.length === 0) {
      errors.push('test_seams must be non-empty when tests_to_add is non-empty');
    }
  }

  if (intake.dependencies_added?.length > 0) {
    const surfaces = intake.allowed_edit_surface ?? [];
    if (!surfaces.some((glob) => glob === 'package.json' || glob.endsWith('/package.json'))) {
      errors.push('dependency changes require package.json in allowed_edit_surface');
    }
    if (!surfaces.includes('pnpm-lock.yaml')) {
      errors.push('dependency changes require pnpm-lock.yaml in allowed_edit_surface');
    }
  }

  for (const approval of intake.required_approvals ?? []) {
    if (!approvalNames.has(approval)) {
      errors.push(`unsupported required_approvals value: ${approval}`);
    }
  }

  for (const command of intake.verification_commands ?? []) {
    if (/\b(test:db:setup|db:setup|drop\s+schema|deploy|migration\s+up)\b/i.test(command)) {
      errors.push(`verification_commands contains a destructive or external command: ${command}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`intake validation failed (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`intake valid: ${resolve(intakePath)}`);
