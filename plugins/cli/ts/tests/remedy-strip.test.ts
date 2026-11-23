import { expect, test } from "bun:test";
import { withoutRemedy } from "./m3/harness/normalize.ts";
import { stripEnvelopeRemedies } from "./remedy-strip.ts";

test("only a failed envelope or a failed row loses its remedy", () => {
  expect(stripEnvelopeRemedies('{"success":false,"data":null,"error":"x","code":"usage","remedy":"ardia browse --help"}')).toBe('{"success":false,"data":null,"error":"x","code":"usage"}');
  const data = '{"success":true,"data":{"remedy":"ardia keep","note":"x"},"error":null}';
  expect(stripEnvelopeRemedies(data)).toBe(data);
  const topOk = '{"ok":false,"remedy":"ardia browse --help","data":{"remedy":"ardia keep"}}';
  expect(stripEnvelopeRemedies(topOk)).toBe(topOk);
  expect(stripEnvelopeRemedies('[{"ok":false,"remedy":"ardia browse --help"}]')).toBe('[{"ok":false}]');
  expect(stripEnvelopeRemedies("plain ,\"remedy\":\"x\" text")).toBe("plain ,\"remedy\":\"x\" text");
});

test("the m3 corpus normalizer keeps a successful payload's remedy", () => {
  const data = '{"success":true,"data":{"value":1,"remedy":"ardia browse snapshot -i"},"error":null}';
  expect(withoutRemedy(data)).toBe(data);
  expect(withoutRemedy('{"success":false,"data":null,"error":"e","code":"stale_ref","remedy":"ardia browse snapshot -i"}')).toBe('{"success":false,"data":null,"error":"e","code":"stale_ref"}');
});

test("every array element counts toward a row's index, objects or not", () => {
  expect(stripEnvelopeRemedies('[0,{"success":false,"remedy":"drop"},{"success":true,"remedy":"keep"}]')).toBe('[0,{"success":false},{"success":true,"remedy":"keep"}]');
  expect(stripEnvelopeRemedies('["a",[1,2],{"success":true,"remedy":"keep"},{"success":false,"remedy":"drop"}]')).toBe('["a",[1,2],{"success":true,"remedy":"keep"},{"success":false}]');
});
