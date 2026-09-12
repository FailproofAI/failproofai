/** Copy for the OS notification raised by an unattended scheduled scan.
 *
 * Deliberately omits the count. A burst of generated fixtures can hit the
 * record cap, and a desktop banner saying "500 leaked credentials" states a
 * conclusion the detector cannot support. The dashboard carries the evidence;
 * the banner's job is only to ask for review. */
export type DesktopLeakEmailState = "sent" | "missing" | "failed" | "held";

export function desktopLeakNotice(email: DesktopLeakEmailState = "held"): { title: string; body: string } {
  const followUp =
    email === "sent"
      ? "A masked alert was also sent to your email."
      : email === "missing"
        ? "Add email alerts with: failproofai audit --schedule --email you@example.com"
        : email === "failed"
          ? "Email delivery failed this time; the local result is still available."
          : "Email was not sent for this run.";
  return {
    title: "failproofai audit needs review",
    body:
      "Possible credential exposure was found in your agent transcripts. " +
      `Run failproofai audit to verify the matches and rotate anything real. ${followUp}`,
  };
}
