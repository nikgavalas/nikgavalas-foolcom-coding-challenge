Generate a concise PR description in markdown based on the changes in the current branch.

Steps:

1. Get the changes for the current PR:

   ```
   gh pr diff
   ```

2. Get the commit history for this branch:

   ```
   gh pr view --json commits --jq '.commits[].messageHeadline'
   ```

3. Analyze the diff and commits, then output a PR description using this format:

   ## What

   A short (2-4 sentence) plain-English summary of what changed and why.

   ## Changes

   - Bullet list of the key changes (group related items, skip trivial noise like formatting)

   ## Testing

   - How to verify the changes work (e.g. run a specific command, open a specific page, what to look for)

Keep it short and skimmable. Avoid restating file names or implementation details that are obvious from the diff. Wrap the entire output in a fenced markdown code block (` ```markdown `) so it is easy to copy-paste. No extra commentary before or after the code block.
