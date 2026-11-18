let peakRssBytes = 0;

function sample() {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, rss, process.resourceUsage().maxRSS * 1024);
  return { rssBytes: rss, peakRssBytes, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal };
}

sample();
const interval = setInterval(sample, 20);
interval.unref();
process.on("message", (message) => {
  if (message === "harnest-memory-sample") process.send({ kind: "current", ...sample() });
});
process.stdin.once("end", () => {
  clearInterval(interval);
  process.send({ kind: "final", ...sample() }, () => process.disconnect());
});
