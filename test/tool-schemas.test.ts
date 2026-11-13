/**
 * The tool contract is public: AI clients call these names with these fields.
 * This test fails when any tool's name, description, hints, input or output shape changes.
 *
 * Changed it on purpose? Run `npm run test:update`, and review the diff of
 * test/__snapshots__/tool-schemas.json in your pull request.
 */
import { expect, it } from "vitest";
import { z } from "zod";
import { TOOLS } from "../src/tools/index.js";

it("the tool contract matches the recorded snapshot", async () => {
  const contract = TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    writes: !!t.writes,
    destructive: !!t.destructive,
    input: z.toJSONSchema(z.object(t.input), { io: "input" }),
    output: z.toJSONSchema(z.object(t.output)),
  }));
  await expect(JSON.stringify(contract, null, 2) + "\n").toMatchFileSnapshot("./__snapshots__/tool-schemas.json");
});

it("tool names are unique and snake_case", () => {
  const names = TOOLS.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
});
