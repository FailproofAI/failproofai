/** Projects page — lists all Claude Agent SDK project folders. */
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
        <h2
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--ink)",
            margin: "0 0 24px",
          }}
        >
          Projects
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
              No projects found in the <code>.claude/projects</code> directory.
            </p>
            <p
              style={{
                color: "var(--dim)",
                fontSize: 12,
                letterSpacing: "0.05em",
              }}
            >
              Run an agent in any folder and it will show up here.
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
