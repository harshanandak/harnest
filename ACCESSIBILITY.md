# Accessibility

Harnest has no graphical interface. You use it through your coding agent's MCP tools and through command-line scripts (`bun run setup`, `bun run doctor`), and all of its output is plain text. Screen readers, terminal magnifiers, and high-contrast terminal themes work the same way they do with any other command-line tool.

The documentation is plain Markdown with headings, lists, and tables, and it renders on GitHub or in any Markdown viewer.

Known limits:

- The optional terminal viewers (`scripts/graph-view.mjs` and similar) print padded text columns, which can be harder to follow with a screen reader. The same data is available as structured JSON through the `handoff_status` and `handoff_trace` tools.
- Each downstream agent (Claude Code, Codex, OpenCode, and others) has its own interface and accessibility support. Harnest cannot change those.

If something in Harnest or its docs gets in your way, [open an issue](https://github.com/harshanandak/harnest/issues/new/choose) and describe the barrier and the tools you use. Accessibility reports get the same priority as bugs.
