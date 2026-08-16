/**
 * Guarded destructive commands for pristine Hire requisitions.
 *
 * This module intentionally stays outside the broad `@hire` barrel and does
 * not own status transitions, retention purges, or downstream artifacts.
 */
export {
  deleteEmptyHireJob,
  type DeleteEmptyHireJobResult,
} from "./services/deleteEmptyHireJob";
export {
  DeleteEmptyHireJobSchema,
  type DeleteEmptyHireJobPayload,
} from "./validators/deleteEmptyHireJob";
