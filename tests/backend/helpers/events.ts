import type { EventSubjects } from "../../../src/backend/events/service.js";

/**
 * The event log's grant rule source for tests that never read the log as a
 * granted user: only those reads ask it, so asking fails the test.
 */
export const OWNER_ONLY_SUBJECTS: EventSubjects = {
  resources: async () => {
    throw new Error("only a granted user's read asks for resources");
  },
  servers: async () => {
    throw new Error("only a granted user's read asks for servers");
  },
};
