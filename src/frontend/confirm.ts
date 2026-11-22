import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  ConfirmRequest,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { useConfirm, type ConfirmOptions } from "@termix-ssh/plugin-sdk/ui";

/**
 * The one way the frontend asks a yes or no question before it acts (#86).
 * A confirm stays open while the person keeps using Termix: the view behind
 * it can move to another connection, resource or host, or close. A yes
 * given after that was for something no longer shown, so it counts as no.
 * tests/frontend/confirm-guard.test.ts fails on any confirm that skips this.
 */

/**
 * Asks with `ask`, then answers true only when the person said yes and
 * `holds` still says the target is the one the question was about. A
 * `holds` that throws or can't tell answers false.
 */
async function confirmWhile<O>(
  ask: (options: O) => Promise<boolean>,
  options: O,
  holds: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (!(await ask(options))) return false;
  try {
    return (await holds()) === true;
  } catch {
    return false;
  }
}

/**
 * A view's confirm, keyed by `target`: what the view acts on, such as the
 * connection, resource uuid and revision. `confirm` resolves false once the
 * view has unmounted or its target is not the one of the render that asked.
 * `still(forTarget)` is the same check for a view's other awaits, and
 * `isMounted()` only asks whether the view is still there.
 */
export function useConfirmFor(target: string) {
  const ask = useConfirm();
  const current = useRef(target);
  current.current = target;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const still = useCallback(
    (forTarget: string) => mounted.current && current.current === forTarget,
    [],
  );
  const isMounted = useCallback(() => mounted.current, []);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      confirmWhile(ask, options, () => still(target)),
    [ask, still, target],
  );
  return useMemo(
    () => ({ confirm, still, isMounted }),
    [confirm, still, isMounted],
  );
}

/**
 * The app-level confirm, for code that runs outside a view (a host menu
 * item in the background frame). `holds` reads the target again once the
 * person said yes; nothing runs unless it still matches.
 */
export function confirmOnApp(
  app: Pick<TermixApp, "confirm">,
  options: ConfirmRequest,
  holds: () => boolean | Promise<boolean>,
): Promise<boolean> {
  return confirmWhile((o: ConfirmRequest) => app.confirm(o), options, holds);
}
