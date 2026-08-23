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

const connectorsUrl = dataUrl(await compile("../src/connectors.ts"));
const toolsSource = (await compile("../src/tools.ts")).replace(
  'from "./connectors"',
  `from ${JSON.stringify(connectorsUrl)}`,
);
assert.doesNotMatch(toolsSource, /from "\.\/connectors"/);
const { findTool } = await import(dataUrl(toolsSource));

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

const shopifyEnv = {
  SHOPIFY_STORE: "store.example.com",
  SHOPIFY_ADMIN_TOKEN: "test-token",
};
const databaseEnv = {
  SUPABASE_URL: "https://database.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
};

async function capturedLimit(toolName, env, args) {
  const requests = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await findTool(toolName).run(env, args);
  assert.equal(requests.length, 1);
  return new URL(requests[0]).searchParams.get("limit");
}

test("both bounded read tools receive the same normalized integer limit", async (t) => {
  const cases = [
    { name: "default", input: undefined, expected: "10" },
    { name: "maximum", input: 50, expected: "50" },
    { name: "above maximum", input: 1000, expected: "50" },
    { name: "below minimum", input: -5, expected: "1" },
    { name: "fractional number", input: 1.9, expected: "1" },
    { name: "fractional string", input: "12.8", expected: "12" },
    { name: "NaN", input: Number.NaN, expected: "10" },
    { name: "positive infinity", input: Number.POSITIVE_INFINITY, expected: "10" },
    { name: "negative infinity", input: Number.NEGATIVE_INFINITY, expected: "10" },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const shopifyLimit = await capturedLimit(
        "shopify_orders",
        shopifyEnv,
        { limit: scenario.input },
      );
      const databaseLimit = await capturedLimit("db_query", databaseEnv, {
        table: "posts",
        limit: scenario.input,
      });
      assert.equal(shopifyLimit, scenario.expected);
      assert.equal(databaseLimit, scenario.expected);
    });
  }
});
