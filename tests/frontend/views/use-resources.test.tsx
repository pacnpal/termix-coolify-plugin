import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createApi } from "../../../src/frontend/api";
import { useResources } from "../../../src/frontend/views/useResources";
import { resourceAnswer, resourceRows, stubApi } from "../fixtures";

// The hook needs only a stable `t`; the app's provider isn't mounted here.
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => {
  const t = (key: string) => key;
  return {
    ...(await original<Record<string, unknown>>()),
    useTranslation: () => ({ t }),
  };
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** One running application: what connection 1 answers the second time. */
const later = {
  rows: [resourceRows[0]],
  counts: { running: 1, degraded: 0, stopped: 0, deploying: 0 },
  fetchedAt: "2026-11-19T10:05:00.000Z",
};

describe("useResources", () => {
  it("drops an answer for A after switching A, B and back to A", async () => {
    const client = stubApi();
    const first = deferred<{ data: unknown }>();
    let asksForOne = 0;
    const answer = client.get.getMockImplementation()!;
    client.get.mockImplementation(async (url: string) => {
      if (url === "/connections/1/resources") {
        asksForOne += 1;
        // The first answer for A is slow and older than the second.
        if (asksForOne === 1) return first.promise;
        return { data: later };
      }
      return answer(url);
    });
    const api = createApi(client);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useResources(api, id, "rev"),
      { initialProps: { id: 1 } },
    );
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.list).not.toBeNull());
    rerender({ id: 1 });
    await waitFor(() => expect(result.current.list?.rows).toHaveLength(1));
    await act(async () => {
      first.resolve({ data: resourceAnswer });
      await first.promise;
    });
    expect(result.current.list?.rows).toHaveLength(1);
    expect(result.current.loading).toBe(false);
  });

  it("an older reload's answer does not replace a newer one", async () => {
    const client = stubApi();
    const slow = deferred<{ data: unknown }>();
    let asks = 0;
    const answer = client.get.getMockImplementation()!;
    client.get.mockImplementation(async (url: string) => {
      if (/^\/connections\/1\/resources/.test(url)) {
        asks += 1;
        if (asks === 2) return slow.promise;
        if (asks === 3) return { data: later };
      }
      return answer(url);
    });
    const api = createApi(client);
    const { result } = renderHook(() => useResources(api, 1, "rev"));
    await waitFor(() => expect(result.current.list).not.toBeNull());
    let older: Promise<void> = Promise.resolve();
    act(() => {
      older = result.current.reload(true);
    });
    await act(() => result.current.reload(true));
    expect(result.current.list?.rows).toHaveLength(1);
    await act(async () => {
      slow.resolve({ data: resourceAnswer });
      await older;
    });
    expect(result.current.list?.rows).toHaveLength(1);
  });
});
