import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMetaRequest,
  LIVE_META_IMPLEMENTED,
  META_API_BASE_URL,
  META_MODEL_ID,
  sendToMeta,
} from "../metaClient.mjs";

test("builds the documented Responses API request shape", () => {
  const req = buildMetaRequest({
    imageBase64: "aGVsbG8=",
    mediaType: "image/jpeg",
    expectedCurrency: "PHP",
    recordType: "expenses",
    apiKey: "test-dummy-key",
  });
  assert.equal(req.url, `${META_API_BASE_URL}/responses`);
  assert.equal(req.method, "POST");
  assert.equal(req.headers.Authorization, "Bearer test-dummy-key");
  assert.equal(req.body.model, META_MODEL_ID);
  assert.equal(req.body.model, "muse-spark-1.3");

  const [message] = req.body.input;
  assert.equal(message.role, "user");
  const image = message.content.find((c) => c.type === "input_image");
  assert.ok(image.image_url.startsWith("data:image/jpeg;base64,"));
  assert.equal(req.body.text.format.type, "json_schema");
  assert.equal(req.body.text.format.strict, true);

  const schema = req.body.text.format.schema;
  assert.ok(schema.properties.entries.items.properties.quantityText);
  assert.ok(schema.properties.entries.items.properties.unitPriceText);
  assert.ok(schema.properties.entries.items.required.includes("quantityText"));
  assert.ok(schema.properties.entries.items.required.includes("unitPriceText"));
  assert.equal(schema.properties.entries.items.additionalProperties, false);
  assert.ok(schema.properties.documentTotalText);
  assert.ok(schema.required.includes("documentTotalText"));
  assert.ok(schema.required.includes("entries"));
  assert.equal(schema.additionalProperties, false);

  const prompt = message.content.find((c) => c.type === "input_text").text;
  assert.match(prompt, /Burger - 2pcs \(65\) = 130/);
  assert.match(prompt, /never multiply or calculate a total yourself/i);
  assert.match(prompt, /in parentheses after a quantity usually indicates the unit price/i);
  assert.match(prompt, /Subtotal, grand-total, and other summary rows are not entries/);
  assert.match(prompt, /must never be included in entries/);
  assert.match(prompt, /documentTotalText/);
  assert.match(prompt, /never calculate, correct, or invent a grand total/i);
  assert.match(prompt, /one date at the top of the record clearly applies to the whole record, use that same date for every entry/);
  assert.match(prompt, /if an individual line has its own date, use that line's date for that entry instead/);
  assert.match(prompt, /report each date exactly as written in dateText/);
  assert.match(prompt, /never add a missing year or turn a relative word into a calendar date/);
});

test("live sending is implemented but only reachable through server gates", () => {
  assert.equal(LIVE_META_IMPLEMENTED, true);
});

test("sendToMeta parses a mocked Responses envelope without any network", async () => {
  const envelope = {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({ entries: [{ description: "Rice (mocked)", amountText: "10.00" }] }),
          },
        ],
      },
    ],
  };
  const fakeFetch = async () => ({
    status: 200,
    text: async () => JSON.stringify(envelope),
  });
  const request = buildMetaRequest({
    imageBase64: "aGVsbG8=",
    mediaType: "image/png",
    expectedCurrency: "PHP",
    recordType: "expenses",
    apiKey: "test-dummy-key",
  });
  const parsed = await sendToMeta(request, fakeFetch);
  assert.equal(parsed.entries[0].description, "Rice (mocked)");
});
