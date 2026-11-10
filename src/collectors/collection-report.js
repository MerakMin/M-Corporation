
export function collectionSummary(results = []) {
  if (!Array.isArray(results)) {
    throw new TypeError("수집 결과는 배열이어야 합니다.");
  }

  const items = results.map((result) => {
    const status =
      result.ok === true
        ? "success"
        : result.ok === false
          ? "failed"
          : "unverified";

    return {
      channel: result.channel ?? "unknown",
      status,
      added: result.added ?? 0,
      error: result.error ?? null,
    };
  });

  return {
    total: items.length,
    success: items.filter(
      (item) => item.status === "success"
    ).length,
    failed: items.filter(
      (item) => item.status === "failed"
    ).length,
    unverified: items.filter(
      (item) => item.status === "unverified"
    ).length,
    added: items.reduce(
      (sum, item) => sum + item.added, 0
    ),
    items,
  };
}
