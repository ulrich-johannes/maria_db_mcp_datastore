import express from "express";
import rateLimit from "express-rate-limit";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config";
import { ensureSchema } from "./db";
import { buildMcpServer } from "./mcpServer";
import {
  SingleUserAuthProvider,
  checkCredentials,
  renderLoginForm,
} from "./authProvider";

async function main() {
  await ensureSchema();

  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

  const authProvider = new SingleUserAuthProvider();

  const app = express();
  // Fly.io puts exactly one proxy hop in front of the app; trusting only that
  // hop (rather than `true`, which trusts an unbounded chain and lets a
  // client spoof X-Forwarded-For) is what express-rate-limit requires for
  // safe IP-based rate limiting.
  app.set("trust proxy", 1);

  // OAuth 2.1 authorization server endpoints: /authorize, /token, /register,
  // and the /.well-known/* metadata documents.
  app.use(
    mcpAuthRouter({
      provider: authProvider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "datastore-mcp state store",
      scopesSupported: ["mcp:state"],
    })
  );

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use(express.urlencoded({ extended: false }));

  app.post("/login", loginLimiter, async (req, res) => {
    const { login_id, username, password } = req.body ?? {};
    if (typeof login_id !== "string" || !authProvider.getPendingLoginId(login_id)) {
      res.status(400).send("This login link has expired. Please try connecting again.");
      return;
    }
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !checkCredentials(username, password)
    ) {
      res
        .status(401)
        .type("html")
        .send(renderLoginForm(login_id, "Incorrect username or password."));
      return;
    }
    await authProvider.completeLogin(login_id, res);
  });

  app.use(
    "/mcp",
    requireBearerAuth({
      verifier: authProvider,
      resourceMetadataUrl,
    })
  );

  app.post("/mcp", express.json(), async (req, res) => {
    try {
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode: GET/DELETE on /mcp are not used for session management.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.listen(config.port, () => {
    console.log(`datastore-mcp listening on port ${config.port}`);
    console.log(`Public URL: ${publicUrl.href}`);
    console.log(`MCP endpoint: ${mcpUrl.href}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  // Do NOT call process.exit() here: stdout/stderr are often piped (as in a
  // Docker/Fly.io container), where writes are asynchronous. An explicit
  // exit() can terminate the process before the error above is flushed,
  // making crashes look like silent, logless deaths. Setting exitCode and
  // letting Node shut down naturally waits for pending writes to flush.
  process.exitCode = 1;
});
