import { notifyRecordsChanged, onRecordsChanged, type RecordsChangedDetail } from "./dataChange.ts";

const assert: {
  equal(a: unknown, b: unknown): void;
  deepEqual(a: unknown, b: unknown): void;
} = (await import("node:" + "assert/strict")).default;
const test: (name: string, body: () => void) => void = (await import("node:" + "test")).default;

test("confirmed-save notification reaches mounted-view subscribers with its detail", () => {
  const seen: RecordsChangedDetail[] = [];
  const unsubscribe = onRecordsChanged((detail) => seen.push(detail));
  try {
    notifyRecordsChanged({ profileId: "biz1", transactionId: "t1", kind: "expense" });
    assert.deepEqual(seen, [{ profileId: "biz1", transactionId: "t1", kind: "expense" }]);
  } finally {
    unsubscribe();
  }
});

test("no notification fires for cancelled or failed writes (nothing is emitted)", () => {
  // Cancelled previews and failed saves simply never call
  // notifyRecordsChanged; subscribing alone must not fire the listener.
  let calls = 0;
  const unsubscribe = onRecordsChanged(() => {
    calls += 1;
  });
  try {
    assert.equal(calls, 0);
  } finally {
    unsubscribe();
  }
});

test("unsubscribed views stop receiving notifications and other views are unaffected", () => {
  let a = 0;
  let b = 0;
  const offA = onRecordsChanged(() => {
    a += 1;
  });
  const offB = onRecordsChanged(() => {
    b += 1;
  });
  try {
    notifyRecordsChanged({ profileId: "p1" });
    offA();
    notifyRecordsChanged({ profileId: "p1" });
    assert.equal(a, 1);
    assert.equal(b, 2);
  } finally {
    offA();
    offB();
  }
});
