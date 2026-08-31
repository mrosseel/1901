import { useEffect, useState } from "react";

import { getJSON } from "../api";
import { TopBar } from "../components/TopBar";

/*
What this build scored against DATC (ADR-045).

DATC is the Diplomacy Adjudicator Test Cases: several hundred positions whose
correct outcome the hobby settled long ago. Every serious adjudicator publishes
its pass rate and it is the first thing anybody asks, so the number goes on a
page rather than into a README nobody can check.

Nothing here is typed. The JSON is written by the test that resolved the cases,
against the same board this server loads from disk, and the page draws whatever
that file says — including a failure, named, if there is one. A hand-written
claim about correctness would go stale the first time the engine moved.

The limits are drawn as prominently as the score. webDiplomacy's own table is
honest about the cases it skips; this one says what it leaves out in the same
place it says what it passed.
*/

export interface DatcFile {
  name: string;
  cases: number;
  passed: number;
  failed: string[];
}

export interface DatcReport {
  engine: string;
  variant: string;
  cases: number;
  passed: number;
  files: DatcFile[];
  limits: string[];
}

export function DatcPage() {
  const [report, setReport] = useState<DatcReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJSON<DatcReport>("/datc.json")
      .then((loaded) => {
        if (!cancelled) setReport(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <TopBar here="datc" />
      <main className="page">
        <h1>Adjudication</h1>
        {error ? (
          <p className="error">{error}</p>
        ) : !report ? (
          <p className="muted">Reading the report…</p>
        ) : (
          <Report report={report} />
        )}
      </main>
    </>
  );
}

function Report({ report }: { report: DatcReport }) {
  const clean = report.passed === report.cases;
  return (
    <>
      <section className="card datc-score">
        <p className="datc-number">
          {report.passed} / {report.cases}
        </p>
        <p className="lead">
          {clean
            ? "Every case in the corpus resolves the way the hobby says it must."
            : "Some cases do not resolve the way the hobby says they must. They are named below."}
        </p>
        <p className="note">
          Run against the {report.variant} board this server loads from disk,
          with godip {report.engine}. The whole corpus runs in CI on every push,
          and this page is written by that run.
        </p>
      </section>

      <section className="card">
        <h2>By file</h2>
        <ul className="datc-files">
          {report.files.map((file) => (
            <li key={file.name}>
              <code>{file.name}</code>
              <span className={file.passed === file.cases ? "datc-pass" : "datc-fail"}>
                {file.passed} / {file.cases}
              </span>
              {file.failed.length ? (
                <ul className="datc-failed">
                  {file.failed.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>What this does not cover</h2>
        <ul className="datc-limits">
          {report.limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
