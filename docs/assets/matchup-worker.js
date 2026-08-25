import { generateCandidates } from "./matchup-core.js";
import { generateExchangeCandidates } from "./exchange-core.js";

self.addEventListener("message", ({ data }) => {
  if (data?.type !== "generate") return;
  try {
    const generator = data.payload?.matchType === "exchange" ? generateExchangeCandidates : generateCandidates;
    const candidates = generator({
      ...data.payload,
      onProgress(progress) {
        self.postMessage({ type: "progress", progress });
      },
    });
    self.postMessage({ type: "result", candidates });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
