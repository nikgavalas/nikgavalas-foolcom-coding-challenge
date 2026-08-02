// Shared between middleware.ts (503 response body) and the article page's
// fallback render, so the two can never drift out of sync.
export const ARTICLE_UNAVAILABLE_MESSAGE =
  "This article is temporarily unavailable. Please try again shortly.";
