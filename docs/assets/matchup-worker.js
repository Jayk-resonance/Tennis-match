import { generateCandidates } from "./matchup-core.js";

self.addEventListener("message", ({ data }) => {
  if (data?.type !== "generate") return;
  try {
    const candidates = generateCandidates({
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
