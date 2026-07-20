import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { todoFilePath, loadTodos, saveTodos, uuid, type TodoItem } from "../shared/utils";

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "No tasks. Use /todo add <task> to create one.";

  const statusIcon = (s: string) => {
    switch (s) {
      case "done": return "✅";
      case "doing": return "🔄";
      default: return "⬜";
    }
  };

  const prioIcon = (p: string) => {
    switch (p) {
      case "high": return "🔴";
      case "medium": return "🟡";
      default: return "🟢";
    }
  };

  const byStatus = (a: TodoItem, b: TodoItem) => {
    const order = { doing: 0, pending: 1, done: 2 };
    return order[a.status] - order[b.status];
  };

  const lines: string[] = ["Tasks:"];
  for (const t of [...todos].sort(byStatus)) {
    const id = t.id.slice(0, 6);
    const task = t.task.length > 80 ? t.task.slice(0, 77) + "..." : t.task;
    lines.push(`  ${statusIcon(t.status)} ${prioIcon(t.priority)} [${id}] ${task}`);
  }
  return lines.join("\n");
}

export function registerTodoCommand(
  register: (name: string, opts: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => void,
) {
  register("todo", {
    description: "Manage project tasks: /todo [list|add|do|done|rm]",
    handler: async (args, ctx) => {
      const filePath = todoFilePath(ctx.cwd);
      const todos = loadTodos(filePath);
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "list";
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        case "list":
        case "ls": {
          ctx.ui.notify(formatTodoList(todos), "info");
          break;
        }

        case "add":
        case "a": {
          if (!rest) {
            ctx.ui.notify("Usage: /todo add <task> [--priority high|medium|low]", "error");
            return;
          }

          let task = rest;
          let priority: TodoItem["priority"] = "medium";

          // Parse --priority flag
          const prioMatch = rest.match(/^(.*?)\s*--priority\s+(high|medium|low)\s*$/);
          if (prioMatch) {
            task = prioMatch[1].trim();
            priority = prioMatch[2] as TodoItem["priority"];
          }

          const item: TodoItem = {
            id: uuid(),
            task,
            status: "pending",
            createdAt: new Date().toISOString(),
            priority,
          };

          todos.push(item);
          saveTodos(filePath, todos);
          ctx.ui.notify(`Added: ${task} [${priority}]`, "success");
          break;
        }

        case "do":
        case "start": {
          const id = rest;
          const found = todos.find((t) => t.id.startsWith(id));
          if (!found) {
            ctx.ui.notify(`Task not found: ${id}`, "error");
            return;
          }
          found.status = "doing";
          saveTodos(filePath, todos);
          ctx.ui.notify(`Started: ${found.task}`, "info");
          break;
        }

        case "done":
        case "complete": {
          const id = rest;
          const found = todos.find((t) => t.id.startsWith(id));
          if (!found) {
            ctx.ui.notify(`Task not found: ${id}`, "error");
            return;
          }
          found.status = "done";
          found.doneAt = new Date().toISOString();
          saveTodos(filePath, todos);
          ctx.ui.notify(`Done: ${found.task}`, "success");
          break;
        }

        case "rm":
        case "remove":
        case "delete": {
          const id = rest;
          const idx = todos.findIndex((t) => t.id.startsWith(id));
          if (idx === -1) {
            ctx.ui.notify(`Task not found: ${id}`, "error");
            return;
          }
          const removed = todos.splice(idx, 1)[0];
          saveTodos(filePath, todos);
          ctx.ui.notify(`Removed: ${removed.task}`, "info");
          break;
        }

        case "clear": {
          const done = todos.filter((t) => t.status === "done");
          if (done.length === 0) {
            ctx.ui.notify("No completed tasks to clear.", "info");
            return;
          }
          const confirmed = await ctx.ui.confirm(
            "Clear completed tasks?",
            `${done.length} completed task(s) will be removed.`,
          );
          if (confirmed) {
            saveTodos(filePath, todos.filter((t) => t.status !== "done"));
            ctx.ui.notify(`Cleared ${done.length} completed task(s).`, "success");
          }
          break;
        }

        default: {
          ctx.ui.notify(
            "Usage:\n  /todo list — show all tasks\n  /todo add <task> — add a task\n  /todo do <id> — start a task\n  /todo done <id> — complete a task\n  /todo rm <id> — remove a task\n  /todo clear — clear completed tasks",
            "info",
          );
        }
      }
    },
  });
}
