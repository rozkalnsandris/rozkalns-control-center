import type { ContinuationPlanResult } from "../../shared/continuation-plan.js";
import {
  planContinuationCurrentReadyTransition,
} from "./continuation-current-ready-transition.js";
import {
  D1ContinuationCurrentReadyStore,
  type ContinuationCurrentReadyPersistenceResult,
  type D1BatchDatabaseLike,
} from "./d1-continuation-current-ready-store.js";
import type { ContinuationCampaignRecoveryEvidence } from "./d1-continuation-campaign-reader.js";
import type { D1DatabaseLike } from "./d1-delivery-claim-store.js";

type ReadyContinuationPlan = Extract<ContinuationPlanResult, { readonly kind: "READY" }>;

export type { ContinuationCurrentReadyPersistenceResult };

/**
 * Persist an already-authoritatively selected current READY unit.
 *
 * This adapter owns only source-level composition of the existing canonical
 * transition planner and atomic D1 store. It performs no GitHub reads, task
 * selection, scheduling or activation. A database without transactional batch
 * support is rejected by the store before any D1 query is issued.
 */
export async function persistContinuationCurrentReady(
  database: D1DatabaseLike,
  recovery: ContinuationCampaignRecoveryEvidence,
  plan: ReadyContinuationPlan,
): Promise<ContinuationCurrentReadyPersistenceResult> {
  const transition = planContinuationCurrentReadyTransition(recovery, plan);
  const store = new D1ContinuationCurrentReadyStore(database as D1BatchDatabaseLike);
  return store.persist(recovery, transition);
}
