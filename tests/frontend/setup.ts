import { configure } from "@testing-library/react";
import { WAIT_MS } from "../shared/timing.js";

// Every findBy and waitFor in the frontend tests waits for fixed work (a
// render against a stubbed API), so it gets WAIT_MS instead of Testing
// Library's 1 s, which a busy machine ran out with nothing wrong (#105). A wait
// that passes returns at once; one that asks for less passes its own timeout.
configure({ asyncUtilTimeout: WAIT_MS });
