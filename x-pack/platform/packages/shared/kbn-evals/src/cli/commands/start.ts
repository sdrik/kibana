/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Path from 'path';
import { spawn } from 'child_process';
import { createFlagError } from '@kbn/dev-cli-errors';
import type { Command } from '@kbn/dev-cli-runner';
import type { ToolingLog } from '@kbn/tooling-log';
import { resolveEvalSuites } from '../suites';
import {
  promptForSuite,
  promptForConnector,
  promptForProject,
  isTTY,
  getAllAvailableConnectors,
} from '../prompts';
import {
  defaultExportProfile,
  envFromDatasetsProfile,
  envFromExportProfile,
  stripTrailingSlash,
  probeHttp,
  isExportProfileImplicitLocal,
} from '../profiles';
import { ensureEvalStack, isEisConnectorId } from '../ensure_eval_stack';

const shellQuote = (value: string): string => {
  // Prefer single quotes for bash/zsh. If the string contains single quotes, fall back to double quotes.
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  const escaped = value.replace(/(["\\$`])/g, '\\$1');
  return `"${escaped}"`;
};

const formatRerunCommand = (args: string[]): string =>
  ['node', 'scripts/evals', ...args.map((a) => (a.includes(' ') ? shellQuote(a) : a))].join(' ');

const ensureSuite = (suiteId: string, repoRoot: string, log: ToolingLog) => {
  const suites = resolveEvalSuites(repoRoot, log);
  const match = suites.find((suite) => suite.id === suiteId);
  if (match) return match;

  log.info(`Suite "${suiteId}" not found in metadata; refreshing discovery...`);
  const refreshed = resolveEvalSuites(repoRoot, log, { refresh: true });
  const refreshedMatch = refreshed.find((suite) => suite.id === suiteId);
  if (refreshedMatch) return refreshedMatch;

  const available = refreshed.map((suite) => suite.id).join(', ');
  throw createFlagError(
    `Unknown suite "${suiteId}". Available suites: ${available || 'none found'}`
  );
};

export const startCmd: Command<void> = {
  name: 'start',
  description: `
  Start the full eval stack (EDOT collector + Scout server + EIS CCM) and run an eval suite.

  Services (EDOT, Scout) run as background daemons and persist between eval runs.
  Use \`node scripts/evals stop\` to shut them down.

  Examples:
    node scripts/evals start
    node scripts/evals start --suite agent-builder
    node scripts/evals start --suite agent-builder --model eis-gpt-4.1
    node scripts/evals start --suite agent-builder --model eis-gpt-4.1,eis-claude-4-sonnet
    node scripts/evals start --suite agent-builder --grep "product documentation"
    node scripts/evals start --suite agent-builder --skip-server
    node scripts/evals stop
  `,
  flags: {
    string: [
      'suite',
      'config',
      'evaluation-connector-id',
      'project',
      'repetitions',
      'grep',
      'profile',
      'datasets-profile',
      'export-profile',
      'evaluations-kbn-url',
      'evaluations-kbn-api-key',
    ],
    boolean: ['skip-server', 'dry-run'],
    alias: { model: 'project', judge: 'evaluation-connector-id' },
    default: { 'skip-server': false, 'dry-run': false },
  },
  run: async ({ log, flagsReader }) => {
    const repoRoot = process.cwd();

    // --- Resolve suite ---
    let suiteId = flagsReader.string('suite');
    const configPath = flagsReader.string('config');

    if (!suiteId && !configPath) {
      if (isTTY()) {
        const selected = await promptForSuite(repoRoot, log);
        suiteId = selected.id;
      } else {
        throw createFlagError('Missing --suite (or provide --config).');
      }
    }

    if (suiteId && configPath) {
      throw createFlagError('Use either --suite or --config, not both.');
    }

    const suite = suiteId ? ensureSuite(suiteId, repoRoot, log) : undefined;
    const resolvedConfigPath = suite
      ? suite.absoluteConfigPath
      : Path.resolve(repoRoot, configPath as string);

    // --- Resolve connector ---
    let evaluationConnectorId =
      flagsReader.string('evaluation-connector-id') ?? process.env.EVALUATION_CONNECTOR_ID;

    if (!evaluationConnectorId) {
      if (isTTY()) {
        evaluationConnectorId = await promptForConnector(repoRoot, log);
      } else {
        throw createFlagError(
          'EVALUATION_CONNECTOR_ID is required. Set --evaluation-connector-id or env.'
        );
      }
    }

    // --- Resolve project (which model(s) to evaluate) ---
    let projects: string[] = [];
    const projectFlag = flagsReader.string('project');

    if (projectFlag) {
      projects = projectFlag.split(',').map((p) => p.trim());
    } else {
      const allConnectors = getAllAvailableConnectors(repoRoot);
      if (allConnectors.length > 1 && isTTY()) {
        projects = await promptForProject(repoRoot, log);
      }
    }

    const skipServer = flagsReader.boolean('skip-server');
    const requiresEisCcm =
      isEisConnectorId(evaluationConnectorId) ||
      (projects.length > 0
        ? projects.some(isEisConnectorId)
        : getAllAvailableConnectors(repoRoot).some((c) => isEisConnectorId(c.id)));

    const baseProfile = flagsReader.string('profile') ?? undefined;
    const datasetsProfile = flagsReader.string('datasets-profile') ?? baseProfile;
    const exportProfile =
      flagsReader.string('export-profile') ?? baseProfile ?? defaultExportProfile(repoRoot);

    const profileEnvOverrides: Record<string, string> = {
      ...envFromDatasetsProfile(repoRoot, datasetsProfile),
      ...envFromExportProfile(repoRoot, exportProfile, {
        defaultTracingExporters: exportProfile === 'local',
      }),
    };

    // Best-effort default: if we implicitly resolved an export profile, don't fail the run when the
    // trace ES isn't reachable. Instead, warn and continue without external trace queries.
    if (isExportProfileImplicitLocal(flagsReader, exportProfile)) {
      const tracingEsUrl = profileEnvOverrides.TRACING_ES_URL;

      const tracingReachable = tracingEsUrl
        ? await probeHttp(stripTrailingSlash(tracingEsUrl))
        : true;

      if (!tracingReachable) {
        log.warning(
          `Export profile \"local\" was auto-selected but TRACING_ES_URL is not reachable (${tracingEsUrl}). ` +
            'Continuing without external trace queries. To require export, pass --export-profile local.'
        );
        delete profileEnvOverrides.TRACING_ES_URL;
        delete profileEnvOverrides.TRACING_ES_API_KEY;
      }
    }

    log.info('');
    log.info(`Suite:     ${suiteId ?? configPath}`);
    log.info(`Judge:     ${evaluationConnectorId}`);
    if (projects.length > 0) {
      log.info(`Models:    ${projects.join(', ')}`);
    } else {
      log.info(`Models:    all (from KIBANA_TESTING_AI_CONNECTORS)`);
    }
    log.info(`Server:    ${skipServer ? 'skip (using existing)' : 'managed'}`);
    if (suite?.serverConfigSet) {
      log.info(`Config:    ${suite.serverConfigSet}`);
    }
    log.info(
      `Profiles:  datasets=${datasetsProfile ?? 'config'} export=${exportProfile ?? 'none'}`
    );
    log.info('');

    const rerunArgs: string[] = [];
    if (suiteId) {
      rerunArgs.push('--suite', suiteId);
    } else if (configPath) {
      rerunArgs.push('--config', configPath);
    }

    rerunArgs.push('--judge', evaluationConnectorId);

    if (projects.length > 0) {
      rerunArgs.push('--model', projects.join(','));
    }

    const passedProfile = flagsReader.string('profile');
    const passedDatasetsProfile = flagsReader.string('datasets-profile');
    const passedExportProfile = flagsReader.string('export-profile');
    if (passedProfile) {
      rerunArgs.push('--profile', passedProfile);
    }
    if (passedDatasetsProfile) {
      rerunArgs.push('--datasets-profile', passedDatasetsProfile);
    }
    if (passedExportProfile) {
      rerunArgs.push('--export-profile', passedExportProfile);
    }

    const grep = flagsReader.string('grep');
    if (grep) {
      rerunArgs.push('--grep', grep);
    }

    const repetitions = flagsReader.string('repetitions');
    if (repetitions) {
      rerunArgs.push('--repetitions', repetitions);
    }

    if (skipServer) {
      rerunArgs.push('--skip-server');
    }

    log.info(`Re-run command: ${formatRerunCommand(['start', ...rerunArgs])}`);
    log.info('');

    if (flagsReader.boolean('dry-run')) {
      log.info('Dry run -- exiting.');
      return;
    }

    if (!skipServer) {
      await ensureEvalStack({
        repoRoot,
        log,
        serverConfigSet: suite?.serverConfigSet ?? 'evals_tracing',
        requiresEisCcm,
        profileEnvOverrides,
      });
    }

    // --- Run the eval suite ---
    log.info(`Running suite: ${suiteId ?? configPath}`);
    log.info('');

    const envOverrides: Record<string, string> = {
      EVALUATION_CONNECTOR_ID: evaluationConnectorId,
    };

    if (suite) {
      envOverrides.EVAL_SUITE_ID = suite.id;
    }

    Object.assign(envOverrides, profileEnvOverrides);

    if (envOverrides.TRACING_ES_URL) {
      log.info(`Trace evaluators will query: ${envOverrides.TRACING_ES_URL}`);
    }
    if (repetitions) {
      envOverrides.EVALUATION_REPETITIONS = repetitions;
    }

    const evaluationsKbnUrl = flagsReader.string('evaluations-kbn-url');
    if (evaluationsKbnUrl) {
      envOverrides.EVALUATIONS_KBN_URL = evaluationsKbnUrl;
    }

    const evaluationsKbnApiKey = flagsReader.string('evaluations-kbn-api-key');
    if (evaluationsKbnApiKey) {
      envOverrides.EVALUATIONS_KBN_API_KEY = evaluationsKbnApiKey;
    }

    const args = ['scripts/playwright', 'test', '--config', resolvedConfigPath];
    for (const p of projects) {
      args.push('--project', p);
    }

    if (grep) {
      args.push('--grep', grep);
    }

    await new Promise<void>((resolve, reject) => {
      const childEnv: Record<string, string> = { ...process.env, ...envOverrides } as Record<
        string,
        string
      >;
      delete childEnv.NO_COLOR;
      const child = spawn('node', args, {
        cwd: repoRoot,
        stdio: 'inherit',
        env: childEnv,
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Playwright exited with code ${code}`));
        }
      });
      child.on('error', reject);
    });

    log.info('');
    log.info('EDOT and Scout are still running in the background.');
    log.info('To stop them: node scripts/evals stop');
  },
};
