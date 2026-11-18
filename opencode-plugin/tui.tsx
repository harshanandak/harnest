/**
 * Harnest workflow widget for the OpenCode CLI.
 *
 * Sidebar: recent workflows in a switcher (click a row, or `/workflows` /
 * `/workflows-next`), followed by the selected workflow as a left-justified
 * waterfall. Rows are flex lines (name left, model right) whose text never
 * wraps, so the widget stays coherent at any sidebar width. Selection is
 * stored durably so every TUI instance agrees. Explicit dynamic workflow
 * controls use the same durable API as MCP and the terminal viewer.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { graphForSession, graphListRows, graphTitle, graphWaterfallRows, listGraphs, workflowAction } from "./dynamic-ui.mjs";

const MUTED = "#9ca3af";
const DIM = "#6b7280";
const SETTINGS = "harnest.graph.settings";
const STATE = "harnest.graph.state";

// The slot callback runs per session; the poll loop reads these to follow the
// active tab without doing store writes inside render.
let currentSessionID = null;
let lastSessionID = null;

const isActive = (graph) => ["running", "queued", "pausing", "paused", "waiting", "stopping"].includes(graph.record?.state);
const progressOf = (record) => {
  const nodes = record?.invocations ?? record?.nodes ?? [];
  const completed = nodes.filter((node) => node.state === "completed").length;
  const running = nodes.filter((node) => node.state === "running").length;
  return `${completed}/${nodes.length}${running ? ` · ${running} running` : ""}`;
};

function selectedGraph(graphs, selectedId) {
  return graphs.find((graph) => graph.id === selectedId)
    ?? graphs.find(isActive)
    ?? graphs[0];
}

function renderCells(cells) {
  return cells.map((cell) => (
    cell.spacer
      ? <box flexGrow={1} minWidth={1} />
      : <text wrapMode="none" fg={cell.color}>{cell.text}</text>
  ));
}

function Line(cells) {
  return <box flexDirection="row" width="100%">{renderCells(cells)}</box>;
}

function GraphWidget(props) {
  const context = usePlugin();
  const [state] = context.storage.memory(STATE, { initial: { graphs: [], error: null } });
  const [settings, updateSettings] = context.storage.store(SETTINGS, { initial: { selected: null } });
  const choose = (id) => {
    void updateSettings((draft) => { draft.selected = id; });
  };
  const render = () => {
    // Read the session prop here so the host re-renders this widget when the
    // active tab changes, and keep the poll loop's session pointer current.
    const sessionID = props?.sessionID ?? props?.session_id ?? null;
    if (sessionID) currentSessionID = sessionID;
    if (state.error) return Line([{ text: "workflows  error", color: "#ef4444" }]);
    const graphs = state.graphs ?? [];
    if (!graphs.length) return Line([{ text: "workflows  none yet", color: MUTED }]);
    const selected = selectedGraph(graphs, settings.selected) ?? graphs[0];
    const blocks = [];
    if (graphs.length > 1) {
      const rows = graphListRows(graphs, { selectedId: selected.id });
      blocks.push(Line(rows[0]));
      graphs.slice(0, 6).forEach((graph, index) => {
        blocks.push(
          <box
            flexDirection="row"
            width="100%"
            onMouseDown={(event) => {
              if (event?.button !== undefined && event.button !== 0) return;
              choose(graph.id);
            }}
            onMouseOver={() => context.renderer?.setMousePointer?.("pointer")}
            onMouseOut={() => context.renderer?.setMousePointer?.("default")}
          >
            {renderCells(rows[index + 1] ?? [])}
          </box>,
        );
      });
      blocks.push(Line([{ text: "click a row to switch · /workflows", color: DIM }]));
    }
    graphWaterfallRows(selected).forEach((cells) => blocks.push(Line(cells)));
    return blocks;
  };
  return <box flexDirection="column" width="100%">{render()}</box>;
}

export default Plugin.define({
  id: "harnest.graph",
  setup(context) {
    const [, updateState] = context.storage.memory(STATE, { initial: { graphs: [], error: null } });
    const [settings, updateSettings] = context.storage.store(SETTINGS, { initial: { selected: null } });
    let stopped = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const graphs = await listGraphs({ selected: settings.selected });
        if (!stopped) updateState((draft) => { draft.graphs = graphs; draft.error = null; });
        // Follow the active tab: when it changes to a session that ran a
        // workflow node, select that workflow. Manual row clicks stick until
        // the next session switch.
        const sessionID = currentSessionID;
        if (sessionID && sessionID !== lastSessionID) {
          lastSessionID = sessionID;
          const mapped = graphForSession(graphs, sessionID);
          if (mapped) await updateSettings((draft) => { draft.selected = mapped.id; });
        }
      } catch (error) {
        if (!stopped) updateState((draft) => { draft.error = String(error?.message ?? error).slice(0, 120); });
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        currentSessionID = props?.sessionID ?? props?.session_id ?? null;
        return <GraphWidget sessionID={currentSessionID} />;
      },
    });
    // The keymap layer needs the Solid context, so it registers from inside a
    // slot render (the documented pattern), not from setup().
    let keysRegistered = false;
    const removeKeys = context.ui.slot({
      append: "app",
      render: () => {
        if (!keysRegistered) {
          keysRegistered = true;
          context.keymap.layer(() => ({
            mode: "global",
            priority: 10,
            commands: [
              ...["pause", "continue", "stop", "stop-agent", "restart-agent", "steer", "reroute", "resume", "session"].map((action) => ({
                id: `harnest.dynamic.${action}`,
                title: `${action} selected JavaScript workflow`,
                group: "Harnest", palette: true,
                slash: { name: `workflow-${action}` },
                run: async () => {
                  const workflows = await listGraphs({ selected: settings.selected });
                  const selected = selectedGraph(workflows, settings.selected);
                  if (selected?.kind !== "dynamic") {
                    context.ui.toast.show({ message: "Select a JavaScript workflow first", variant: "info" });
                    return;
                  }
                  try {
                    const result = await workflowAction(selected, action, context.ui);
                    if (result) context.ui.toast.show({ title: graphTitle(selected), message: `${action}: ${result.state ?? "recorded; inspect status"}` });
                    await refresh();
                  } catch (error) { context.ui.toast.show({ message: String(error?.message ?? error).slice(0, 200), variant: "error" }); }
                },
              })),
              {
                id: "harnest.workflow.switch",
                title: "Switch workflow",
                group: "Harnest",
                palette: true,
                slash: { name: "workflows" },
                run: async () => {
                  const graphs = await listGraphs();
                  if (!graphs.length) {
                    context.ui.toast.show({ message: "No workflows found", variant: "info" });
                    return;
                  }
                  const chosen = await context.ui.dialog.select({
                    title: "Switch workflow",
                    current: settings.selected,
                    options: graphs.map((graph) => ({
                      title: graphTitle(graph),
                      value: graph.id,
                      description: `${graph.record?.state ?? "unknown"} · ${progressOf(graph.record)}`,
                      category: isActive(graph) ? "Running" : "Finished",
                    })),
                  });
                  if (chosen) await updateSettings((draft) => { draft.selected = chosen; });
                },
              },
              {
                id: "harnest.workflow.next",
                title: "Show next workflow",
                group: "Harnest",
                palette: true,
                slash: { name: "workflows-next" },
                run: async () => {
                  const graphs = await listGraphs();
                  if (graphs.length < 2) {
                    context.ui.toast.show({ message: "Only one workflow in the store", variant: "info" });
                    return;
                  }
                  const index = Math.max(0, graphs.findIndex((graph) => graph.id === settings.selected));
                  const next = graphs[(index + 1) % graphs.length];
                  await updateSettings((draft) => { draft.selected = next.id; });
                  context.ui.toast.show({ title: "Workflow", message: graphTitle(next) });
                },
              },
            ],
          }));
        }
        return null;
      },
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      if (typeof removeSlot === "function") removeSlot();
      if (typeof removeKeys === "function") removeKeys();
    };
  },
});
