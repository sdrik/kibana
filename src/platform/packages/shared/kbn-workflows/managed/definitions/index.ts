/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW,
  ATTACK_DISCOVERY_CUSTOM_VALIDATION_EXAMPLE_WORKFLOW,
  ATTACK_DISCOVERY_GENERATION_WORKFLOW,
  ATTACK_DISCOVERY_RUN_EXAMPLE_WORKFLOW,
  ATTACK_DISCOVERY_VALIDATE_WORKFLOW,
} from './discoveries';
import { EXAMPLE_MANAGED_WORKFLOW } from './workflows_extensions_example';

export {
  ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
  ATTACK_DISCOVERY_CUSTOM_VALIDATION_EXAMPLE_WORKFLOW_ID,
  ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
  ATTACK_DISCOVERY_RUN_EXAMPLE_WORKFLOW_ID,
  ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
} from './discoveries';
export { EXAMPLE_MANAGED_WORKFLOW_ID } from './workflows_extensions_example';

export const managedWorkflowDefinitions = [
  ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW,
  ATTACK_DISCOVERY_CUSTOM_VALIDATION_EXAMPLE_WORKFLOW,
  ATTACK_DISCOVERY_GENERATION_WORKFLOW,
  ATTACK_DISCOVERY_RUN_EXAMPLE_WORKFLOW,
  ATTACK_DISCOVERY_VALIDATE_WORKFLOW,
  EXAMPLE_MANAGED_WORKFLOW,
] as const;
