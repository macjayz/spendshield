"use client";

import { useState } from "react";

/**
 * Show a long list a page at a time. `mustShow` is an index that has to be on screen (a deep link like
 * #request-19), so the list grows to include it instead of hiding the row the link points at.
 */
export function usePaged(total: number, step = 10, mustShow = -1) {
  const [limit, setLimit] = useState(step);
  const shown = Math.min(total, Math.max(limit, mustShow + 1));
  return {
    shown,
    rest: total - shown,
    more: () => setLimit(shown + step),
    all: () => setLimit(total),
    step,
  };
}

export function ShowMore({ paged, noun }: { paged: ReturnType<typeof usePaged>; noun: string }) {
  if (paged.rest <= 0) return null;
  return (
    <div className="show-more">
      <span className="fine">
        Showing {paged.shown} of {paged.shown + paged.rest} {noun}
      </span>
      <button type="button" className="btn small secondary" onClick={paged.more}>
        Show {Math.min(paged.step, paged.rest)} more
      </button>
      {paged.rest > paged.step && (
        <button type="button" className="btn small ghost" onClick={paged.all}>
          Show all
        </button>
      )}
    </div>
  );
}
