import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CodexAuthError } from "../src/auth";
import { CodexProvider, SourceError } from "../src/provider";

afterEach(() => mock.restore());
const usage = {
  rate_limit: {
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 18_000,
      reset_at: 1_800_000_000,
    },
    secondary_window: {
      used_percent: 20,
      limit_window_seconds: 604_800,
      reset_at: 1_800_001_000,
    },
  },
};
function setup() {
  const refreshes: boolean[] = [];
  const provider = new CodexProvider({
    async credentials(force = false) {
      refreshes.push(force);
      return { token: "test-token", accountId: "test" };
    },
  });
  return { provider, refreshes };
}

describe("authorization failures", () => {
  test("a 401 recovered by refresh does not trigger an auth incident", async () => {
    const { provider, refreshes } = setup();
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(usage))
      .mockResolvedValueOnce(
        Response.json({ available_count: 0, credits: [] }),
      );
    const result = await provider.read();
    expect(refreshes).toEqual([false, true]);
    expect(result.creditsError).toBe(false);
  });
  test("a usage 401 after refresh is a typed authorization failure", async () => {
    const { provider, refreshes } = setup();
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    await expect(provider.read()).rejects.toBeInstanceOf(CodexAuthError);
    expect(refreshes).toEqual([false, true]);
  });
  test("credit authorization failures are not swallowed as an inventory outage", async () => {
    const { provider } = setup();
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(usage))
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(provider.read()).rejects.toBeInstanceOf(CodexAuthError);
  });
  test("an invalid CLI session propagates without making authenticated requests", async () => {
    const provider = new CodexProvider({
      async credentials() {
        throw new CodexAuthError();
      },
    });
    const request = spyOn(globalThis, "fetch");
    await expect(provider.read()).rejects.toBeInstanceOf(CodexAuthError);
    expect(request).not.toHaveBeenCalled();
  });
  test("ordinary network and server failures are not labelled as a broken session", async () => {
    const { provider } = setup();
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    await expect(provider.read()).rejects.toBeInstanceOf(SourceError);
  });
});
