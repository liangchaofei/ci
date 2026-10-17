# Agent Runtime Course Repository

This branch starts a new Agent Runtime course. The earlier chapters and implementation remain in Git history and on their original branches; they are not prerequisites for this series.

## Current division of work

- The assistant owns the initial project and website scaffolding, the published tutorial text, candidate implementations in a temporary verification directory, and review/debugging of the learner's work.
- The learner writes the Runtime implementation in `src/` by following the published chapters. Do not add Runtime core code to this branch on the assistant's initiative. A later direct user request may change this division.
- The learner normally commits each finished chapter after review. Do not commit, push, open a pull request, merge, or deploy the website without a direct request from the user. Branch creation and local editing are already authorized.

## Course contract

- `site/` contains the tracked VitePress site that can later build for GitHub Pages. The ignored `docs/` folder contains legacy local notes and is not part of this course.
- Only a chapter with complete, verified instructions may appear as a tutorial page. Future chapters belong in the roadmap until their code, commands, traces, and failure paths have been checked in a temporary project or the chapter's source version.
- Every implementation chapter names all new and changed files, explains what each one does and why, gives complete final contents, shows how to run and debug it, and states what behavior proves completion. Code blocks labelled as the final implementation must be executable together without missing imports or hidden steps.
- Put concise Chinese comments at important code boundaries, especially state transitions, side-effect gates, result correlation, and exceptional exits. Explain the reason for a choice in prose; avoid comments that merely repeat the syntax.
- Follow `TUTORIAL-WRITING.md`: explain a concrete execution trace, teach the implementation incrementally, and collect complete files at the end. Do not lead with complete files and summarize them afterward.
- Assume zero prior Agent knowledge. Explain each new Agent term at first use in plain Chinese, connect it to the running scenario and code, and avoid definitions that depend on other unexplained terms. Basic programming familiarity is the prerequisite; relevant TypeScript mechanisms still need local explanations.
- Teach both the implementation and the system knowledge progressively: problem, limitation of the current system, mechanism, design, code, execution trace, and debugging. Audit chapter prerequisites, link earlier explanations where needed, and introduce one primary mechanism at a time. The website must support independent learning without requiring this chat or prior Pi knowledge; a runnable example alone is not an adequate lesson.
- Provide early runnable checkpoints that reuse the same scenario code and converge on one final implementation. Teach the feedback path before layering reliability, explain the limits of fixed workflows before introducing general scheduling, and show which simulated dependencies will later be replaced. Verify each checkpoint and its migration, not just the final files.
- Unit-test teaching is currently deferred. Do not add unit-test writing tasks or new unit-test files; keep the existing environment check and verify chapters with runnable examples, traces, debugging, and reversible fault experiments.
- Keep the public website independent of this chat: no personal progress, local absolute paths, private handoff notes, or tutor/student arrangements in tutorial prose.
- Use Pi Agent Core as a local design comparison after explaining and validating the same behavior in this project. Do not copy Pi wholesale or present its current `main` as an immutable reference; pin source links when possible.
- A passing test proves that implementation behavior, not that a reader has mastered the concept.

## Current state

The new branch contains engineering and website scaffolding only. Chapter 00 documents that baseline. Runtime implementation begins with Chapter 01, to be written by the learner.

The current teaching priority is refining Chapter 01 from learner feedback. Wait for the user to ask to advance before writing the next chapter. Each chapter must begin with a recommended `codex/chapter-NN-topic` branch name and a copyable `git switch -c` command, based on the preceding chapter's completed local commit. The learner creates these branches and makes commits.

End each chapter with copyable staging, commit, and push commands, including a descriptive chapter-specific commit message and its recommended branch. Stage explicit chapter paths, except when saving the whole Chapter 00 foundation. Explain the verification and experiment-restoration prerequisites. Publishing these instructions does not authorize executing them on the learner's behalf.

Use Chinese commit titles and detailed bodies. Explain purpose, concrete changes, and actual verification; never claim unperformed checks passed. Supply literal multiline messages with `git commit -F -` and a quoted heredoc delimiter so the copied text preserves newlines without shell expansion.
