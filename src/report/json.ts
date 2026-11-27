import type { PaperReport, Reporter } from "./types.js";

export const jsonReporter: Reporter = {
  filename: "report.json",
  render: (report: PaperReport) => `${JSON.stringify(report, null, 2)}\n`,
};
