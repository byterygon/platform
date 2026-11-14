import { useState } from "react";
import { Pagination } from "@/components/pagination/pagination";

/** The smallest useful Pagination: five pages. */
export function PaginationMinimal() {
  const [page, setPage] = useState(2);
  return <Pagination page={page} pageCount={5} onPageChange={setPage} />;
}

/** The audit log browser: many pages with gaps, a small one in a toolbar, and one disabled while a page loads. */
export function PaginationRealistic() {
  const [page, setPage] = useState(12);
  return (
    <div className="flex flex-col items-start gap-stack-md">
      <div className="flex flex-wrap items-center gap-inline-md">
        <Pagination page={page} pageCount={40} onPageChange={setPage} labels={{ nav: "Audit log pages" }} />
        <span className="text-body text-fg-muted">
          Page {page} of 40, 50 records each
        </span>
      </div>
      <Pagination size="sm" page={1} pageCount={3} labels={{ nav: "Result pages" }} />
      <Pagination page={3} pageCount={8} disabled labels={{ nav: "Loading pages" }} />
    </div>
  );
}
