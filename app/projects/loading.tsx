/** Skeleton loading UI for the projects page — audit-styled to match
 *  the dashed `.panel` chrome of the loaded state. Staggered fade-in on the
 *  rows gives the skeleton its own rhythm rather than every bar blinking in
 *  lockstep. */
export default function ProjectsLoading() {
  return (
    <main className="report">
      <section className="section" data-screen-label="projects">
        <div className="section-mast">
          <div className="section-label">
            <span className="glyph">━━</span> projects
          </div>
          <div
            className="section-meta"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="p">●</span> loading…
          </div>
        </div>
        <h2 className="section-h" style={{ textTransform: "none" }}>
          your agent footprint.
        </h2>
        <div className="panel" style={{ padding: 24 }}>
          <div className="bg-muted h-6 w-40 mb-5 animate-pulse" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="bg-muted/50 h-10 audit-row-enter"
                style={{ ["--row-delay" as string]: `${i * 60}ms` }}
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
