import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardTransport } from "../src/dashboard";
import { reconcile } from "../src/detect";
import { Store } from "../src/store";

function setup() {
  const store = new Store(":memory:");
  const calls: { action: string; id: number }[] = [];
  let nextId = 0;
  const transport: DashboardTransport = {
    async send() {
      const id = ++nextId;
      calls.push({ action: "send", id });
      return id;
    },
    async edit(id) {
      calls.push({ action: "edit", id });
      return true;
    },
    async remove(id) {
      calls.push({ action: "delete", id });
    },
  };
  const data = reconcile(null, {
    accountId: "test",
    checkedAt: Date.now() / 1000,
    weekly: { remaining: 97, resetsAt: null },
    fiveHour: { remaining: 6, resetsAt: null },
    credits: [],
  }).state;
  store.commit(data, [], []);
  return {
    store,
    calls,
    transport,
    data,
    dashboard: new Dashboard(store, transport),
  };
}

describe("live dashboard lifecycle", () => {
  test("one current id is persisted, replaced on button press, and only the latest is edited", async () => {
    const { store, calls, dashboard, data } = setup();
    let reads = 0;
    const readNow = async () => {
      reads++;
    };
    await dashboard.replace(readNow);
    await dashboard.replace(readNow);
    data.snapshot.weekly = { remaining: 96, resetsAt: null };
    store.commit(data, [], []);
    await dashboard.refresh();
    expect(reads).toBe(2);
    expect(calls).toEqual([
      { action: "send", id: 1 },
      { action: "delete", id: 1 },
      { action: "send", id: 2 },
      { action: "edit", id: 2 },
    ]);
    expect(JSON.parse(store.get("dashboard") ?? "null").id).toBe(2);
    store.close();
  });
  test("timer updates do not create messages or send unchanged edits", async () => {
    const { store, calls, dashboard } = setup();
    await dashboard.refresh();
    expect(calls).toHaveLength(0);
    await dashboard.replace(async () => {});
    await dashboard.refresh();
    expect(calls).toEqual([{ action: "send", id: 1 }]);
    store.close();
  });
  test("a new controller resumes the saved dashboard", async () => {
    const { store, calls, dashboard, transport, data } = setup();
    await dashboard.replace(async () => {});
    data.snapshot.fiveHour = { remaining: 5, resetsAt: null };
    store.commit(data, [], []);
    await new Dashboard(store, transport).refresh();
    expect(calls.at(-1)).toEqual({ action: "edit", id: 1 });
    store.close();
  });
  test("concurrent replacements and refreshes never edit a retired message", async () => {
    const { store, calls, dashboard, data } = setup();
    await dashboard.replace(async () => {});
    data.snapshot.fiveHour = { remaining: 4, resetsAt: null };
    store.commit(data, [], []);
    await Promise.all([
      dashboard.replace(async () => {}),
      dashboard.refresh(),
      dashboard.replace(async () => {}),
    ]);
    expect(calls).toEqual([
      { action: "send", id: 1 },
      { action: "delete", id: 1 },
      { action: "send", id: 2 },
      { action: "delete", id: 2 },
      { action: "send", id: 3 },
    ]);
    store.close();
  });
  test("a failed deletion prevents a duplicate dashboard and can be retried", async () => {
    const { store, calls, dashboard, transport } = setup();
    await dashboard.replace(async () => {});
    const remove = transport.remove;
    transport.remove = async () => {
      throw new Error("delete rejected");
    };
    await expect(dashboard.replace(async () => {})).rejects.toThrow(
      "delete rejected",
    );
    expect(calls).toEqual([{ action: "send", id: 1 }]);
    transport.remove = remove;
    await dashboard.replace(async () => {});
    expect(calls.at(-1)).toEqual({ action: "send", id: 2 });
    store.close();
  });
  test("a manually deleted dashboard is cleared without recreating it", async () => {
    const { store, dashboard, transport, data } = setup();
    await dashboard.replace(async () => {});
    data.snapshot.fiveHour = { remaining: 3, resetsAt: null };
    store.commit(data, [], []);
    transport.edit = async () => false;
    await dashboard.refresh();
    expect(store.get("dashboard")).toBe("null");
    store.close();
  });
});
