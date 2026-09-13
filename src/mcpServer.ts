import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createVar,
  getVar,
  updateVar,
  deleteVar,
  listVars,
  ConflictError,
  NotFoundError,
  StateRow,
} from "./db";

function rowToText(row: StateRow): string {
  return JSON.stringify(
    {
      var_name: row.var_name,
      description: row.description,
      content: row.content,
      created: row.created,
      last_updated: row.last_updated,
      deleted: !!row.deleted,
    },
    null,
    2
  );
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "datastore-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "state_create",
    {
      title: "Create state variable",
      description:
        "Create a new named variable in the persistent state store. Fails if a variable with this name already exists (and is not deleted).",
      inputSchema: {
        var_name: z.string().min(1).max(255).describe("Unique name/key for the variable."),
        description: z.string().max(1000).optional().describe("Short human-readable description."),
        content: z.string().optional().describe("The value to store (can be very long text)."),
      },
    },
    async ({ var_name, description, content }) => {
      try {
        const row = await createVar(var_name, description ?? null, content ?? null);
        return { content: [{ type: "text", text: rowToText(row) }] };
      } catch (err) {
        if (err instanceof ConflictError) return errorResult(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "state_get",
    {
      title: "Get state variable",
      description: "Read a variable's full record (description, content, timestamps) by name.",
      inputSchema: {
        var_name: z.string().min(1).max(255),
      },
    },
    async ({ var_name }) => {
      const row = await getVar(var_name, false);
      if (!row) return errorResult(`Variable "${var_name}" was not found.`);
      return { content: [{ type: "text", text: rowToText(row) }] };
    }
  );

  server.registerTool(
    "state_update",
    {
      title: "Update state variable",
      description:
        "Update the description and/or content of an existing variable. Fields omitted are left unchanged.",
      inputSchema: {
        var_name: z.string().min(1).max(255),
        description: z.string().max(1000).optional(),
        content: z.string().optional(),
      },
    },
    async ({ var_name, description, content }) => {
      try {
        const row = await updateVar(var_name, { description, content });
        return { content: [{ type: "text", text: rowToText(row) }] };
      } catch (err) {
        if (err instanceof NotFoundError) return errorResult(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "state_delete",
    {
      title: "Delete state variable",
      description:
        "Soft-delete a variable (sets its deleted flag). It will no longer appear in list/get results but is not physically removed.",
      inputSchema: {
        var_name: z.string().min(1).max(255),
      },
    },
    async ({ var_name }) => {
      try {
        await deleteVar(var_name);
        return { content: [{ type: "text", text: `Variable "${var_name}" deleted.` }] };
      } catch (err) {
        if (err instanceof NotFoundError) return errorResult(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "state_list",
    {
      title: "List state variables",
      description:
        "List variable names and descriptions (not content) currently in the store.",
      inputSchema: {
        include_deleted: z
          .boolean()
          .optional()
          .describe("Include soft-deleted variables in the list. Defaults to false."),
      },
    },
    async ({ include_deleted }) => {
      const items = await listVars(include_deleted ?? false);
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  return server;
}
