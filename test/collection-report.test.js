
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectionSummary,
} from "../src/collectors/collection-report.js";

test("판매처별 수집 결과를 정확하게 요약한다", () => {
  const report = collectionSummary([
    {
      channel: "fashionplus",
      ok: true,
      added: 5,
    },
    {
      channel: "coupang",
      ok: false,
      added: 0,
      error: "로그인 확인 필요",
    },
    {
      channel: "cafe24",
    },
  ]);

  assert.equal(report.total, 3);
  assert.equal(report.success, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.unverified, 1);
  assert.equal(report.added, 5);
  assert.equal(report.items[1].error, "로그인 확인 필요");
});
