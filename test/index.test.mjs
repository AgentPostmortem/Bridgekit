import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import ts from "typescript";

async function compile(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);
  return compiled.outputText;
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const authUrl = dataUrl(await compile("../src/auth.ts"));
const connectorsUrl = dataUrl(await compile("../src/connectors.ts"));
const toolsSource = (await compile("../src/tools.ts")).replace(
  'from "./connectors"',
  `from ${JSON.stringify(connectorsUrl)}`,
);
const toolsUrl = dataUrl(toolsSource);
const auditSource = (await compile("../src/audit.ts")).replace(
  'from "./auth"',
  `from ${JSON.stringify(authUrl)}`,
);
const auditUrl = dataUrl(auditSource);
const indexSource = (await compile("../src/index.ts"))
  .replace('from "./auth"', `from ${JSON.stringify(authUrl)}`)
  .replace('from "./audit"', `from ${JSON.stringify(auditUrl)}`)
  .replace('from "./tools"', `from ${JSON.stringify(toolsUrl)}`);
const { default: worker } = await import(dataUrl(indexSource));

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function aiRequest(env, headers = {}) {
  return worker.fetch(
    new Request("https://bridgekit.test/ai", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ prompt: "Explain Bridgekit" }),
    }),
    env,
  );
}

function mcpRequest(env, body) {
  return worker.fetch(
    new Request("https://bridgekit.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridgekit-key": "client-key",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

test("rejects non-object JSON-RPC request bodies", async (t) => {
  const env = {
    BRIDGEKIT_CLIENTS: JSON.stringify({
      "client-key": { name: "reader", tools: [], allowWrite: false },
    }),
  };

  for (const body of [null, [], "ping", 42, true]) {
    await t.test(JSON.stringify(body), async () => {
      const response = await mcpRequest(env, body);

      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "invalid request" },
      });
    });
  }
});

test("tools/call rejects non-object arguments", async (t) => {
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response("{}");
  };
  const env = {
    BRIDGEKIT_CLIENTS: JSON.stringify({
      "client-key": {
        name: "writer",
        tools: ["shopify_tag_order"],
        allowWrite: true,
      },
    }),
  };

  for (const argumentsValue of ["vip", null, [], 42, true]) {
    await t.test(JSON.stringify(argumentsValue), async () => {
      const response = await mcpRequest(env, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "shopify_tag_order", arguments: argumentsValue },
      });

      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32602, message: "invalid params: arguments must be an object" },
      });
    });
  }
  assert.equal(upstreamCalls, 0);
});

test("/ai rejects requests without a client key before calling the model", async () => {
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "model reply" } }] }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const response = await aiRequest({
    GROQ_API_KEY: "test-groq-key",
    BRIDGEKIT_CLIENTS: "{}",
  });

  assert.equal(response.status, 401);
  assert.equal(upstreamCalls, 0);
});

test("/ai still serves an authenticated client", async () => {
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "model reply" } }] }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const response = await aiRequest(
    {
      GROQ_API_KEY: "test-groq-key",
      BRIDGEKIT_CLIENTS: JSON.stringify({
        "client-key": { name: "test client", tools: [], allowWrite: false },
      }),
    },
    { "x-bridgekit-key": "client-key" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "model reply" });
  assert.equal(requestedUrl, "https://api.groq.com/openai/v1/chat/completions");
});
