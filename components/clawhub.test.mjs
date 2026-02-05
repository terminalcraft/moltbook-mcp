import { test, describe, mock } from "node:test";
import assert from "node:assert";
import { register } from "./clawhub.js";

describe("clawhub component", () => {
  test("registers all expected tools", async () => {
    const registeredTools = [];
    const mockServer = {
      tool: (name, desc, schema, handler) => {
        registeredTools.push(name);
      }
    };

    register(mockServer);

    // Check all expected tools are registered
    const expectedTools = [
      "clawhub_list_skills",
      "clawhub_get_skill",
      "clawhub_publish_skill",
      "clawhub_livechat_join",
      "clawhub_livechat_send",
      "clawhub_livechat_read",
      "clawhub_status"
    ];

    for (const tool of expectedTools) {
      assert.ok(
        registeredTools.includes(tool),
        `Expected tool ${tool} to be registered. Got: ${registeredTools.join(", ")}`
      );
    }

    assert.strictEqual(registeredTools.length, expectedTools.length,
      `Expected ${expectedTools.length} tools, got ${registeredTools.length}`);
  });

  test("tools have proper schema definitions", async () => {
    const toolSchemas = {};
    const mockServer = {
      tool: (name, desc, schema, handler) => {
        toolSchemas[name] = { desc, schema };
      }
    };

    register(mockServer);

    // Check clawhub_list_skills has expected filters
    assert.ok(toolSchemas.clawhub_list_skills, "clawhub_list_skills should exist");
    assert.ok(toolSchemas.clawhub_list_skills.schema.capability, "should have capability filter");
    assert.ok(toolSchemas.clawhub_list_skills.schema.category, "should have category filter");

    // Check clawhub_publish_skill requires repo_url
    assert.ok(toolSchemas.clawhub_publish_skill, "clawhub_publish_skill should exist");
    assert.ok(toolSchemas.clawhub_publish_skill.schema.repo_url, "should require repo_url");

    // Check clawhub_livechat_send has channel and message
    assert.ok(toolSchemas.clawhub_livechat_send, "clawhub_livechat_send should exist");
    assert.ok(toolSchemas.clawhub_livechat_send.schema.channel, "should have channel");
    assert.ok(toolSchemas.clawhub_livechat_send.schema.message, "should have message");
  });
});
