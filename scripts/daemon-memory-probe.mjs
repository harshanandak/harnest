let peakRssBytes = 0;
function sample() {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, rss, process.resourceUsage().maxRSS * 1024);
  return { rssBytes: rss, peakRssBytes, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal };
}
sample();
setInterval(sample, 20).unref();
process.on("message", (message) => {
  if (message === "sample") process.send({ kind: "sample", ...sample() });
});
process.channel?.unref();
