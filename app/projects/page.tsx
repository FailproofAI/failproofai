/** Projects page — lists all Claude Agent SDK project folders.
 *
 * Wrapped in the audit `.report` + `.section` chrome so the page picks up
 * the unified design system: mono fonts, section masthead with the ━━
 * glyph + green eyebrow label, and the dashed-frame `.panel` around the
 * project list when it's populated. The inner ProjectList component is
 * unchanged — every Tailwind utility it uses (bg-card, text-foreground,
 * border-border, …) now resolves to the audit palette globally.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getCachedProjectFolders } from "@/lib/projects";
import ProjectList from "@/app/components/project-list";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const disabled = (process.env.FAILPROOFAI_DISABLE_PAGES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (disabled.includes("projects")) notFound();

  const folders = await getCachedProjectFolders();
  const count = folders.length;

  return (
    <main className="report">
      <section className="section" data-screen-label="projects">
        <div className="section-mast">
          <div className="section-label">
            <span className="glyph">━━</span> projects
          </div>
          <div className="section-meta">
            <span className={count > 0 ? "g" : "p"}>●</span>{" "}
            {count} {count === 1 ? "folder" : "folders"}
          </div>
        </div>
        <h2 className="section-h" style={{ textTransform: "none" }}>
          your agent footprint.
        </h2>

        {count === 0 ? (
          <div
            className="panel"
            style={{ textAlign: "center", padding: "56px 32px" }}
          >
            <div aria-hidden="true" style={{ marginBottom: 20 }}>
              <div
                style={{
                  display: "inline-grid",
                  gridTemplateColumns: "repeat(6, 10px)",
                  gridTemplateRows: "repeat(6, 10px)",
                  gap: 2,
                  padding: 12,
                  border: "1px solid var(--line-2)",
                  background: "var(--bg)",
                  boxShadow: "4px 4px 0 0 var(--accent-pink-shadow)",
                }}
              >
                {Array.from({ length: 36 }).map((_, i) => {
                  // a sparse "empty box" glyph
                  const on = [0, 5, 30, 35, 7, 10, 25, 28].includes(i);
                  return (
                    <span
                      key={i}
                      style={{
                        background: on ? "var(--dim)" : "transparent",
                      }}
                    />
                  );
                })}
              </div>
            </div>
            <p style={{ color: "var(--ink-2)", marginBottom: 8 }}>
              no projects found in the <code style={{ color: "var(--accent-pink)" }}>.claude/projects</code> directory.
            </p>
            <p
              style={{
                color: "var(--dim)",
                fontSize: 12,
                letterSpacing: "0.05em",
              }}
            >
              run an agent in any folder and it will show up here.
            </p>
          </div>
        ) : (
          <div className="panel" style={{ padding: 0 }}>
            <Suspense>
              <ProjectList folders={folders} />
            </Suspense>
          </div>
        )}
      </section>
    </main>
  );
}
