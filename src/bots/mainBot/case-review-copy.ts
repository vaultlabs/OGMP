/** Shared Case Review (REPORT bot) intro — open new vs append evidence. */
export function caseReviewOpenMessage(opts: {
  mode: "new" | "append";
  reportCode?: string;
  status?: string;
}): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Case Review",
    "━━━━━━━━━━━━━━━━━━",
    "",
  ];
  if (opts.mode === "append" && opts.reportCode) {
    lines.push(
      "What: case already open — add evidence.",
      "Safe: use only the REPORT bot session from the button below.",
      "Next: tap **Open REPORT bot**, upload files, then `/append_done`.",
      "",
      `Code: \`${opts.reportCode}\`${opts.status ? ` (${opts.status})` : ""}`,
    );
  } else {
    lines.push(
      "What: submit evidence in the REPORT bot.",
      "Safe: deal stays linked; do not move pay outside the bot.",
      "Next: tap **Open REPORT bot** below and follow the prompts.",
    );
  }
  lines.push("", "_Private session — do not forward._");
  return lines.join("\n");
}
