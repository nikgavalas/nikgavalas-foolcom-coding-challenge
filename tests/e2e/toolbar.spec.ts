import { expect, test } from "@playwright/test";

import { listArticles } from "@/lib/cmsMock";

const [seedArticle] = listArticles();

test("MockSourcesToolbar renders every failure mode as a link", async ({
  page,
}) => {
  await page.goto(`/articles/${seedArticle.path}`);

  const modes = ["healthy", "slow", "down", "hang", "corrupt"];
  for (const mode of modes) {
    await expect(page.getByRole("link", { name: mode, exact: true })).toBeVisible();
  }

  await expect(
    page.getByRole("button", { name: "publish correction" }),
  ).toBeVisible();
});
