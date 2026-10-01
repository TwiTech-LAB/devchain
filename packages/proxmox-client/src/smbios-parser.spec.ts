import { configCarriesCloneMarker, parseSmbiosUuid } from "./smbios-parser";

describe("parseSmbiosUuid", () => {
  const uuid = "7f3b9c2e-7c1a-4c8f-9d0e-1a2b3c4d5e6f";

  it("parses the UUID from a full smbios1 value", () => {
    expect(
      parseSmbiosUuid({
        smbios1: `uuid=${uuid},manufacturer=DevChain,serial=none`,
      }),
    ).toBe(uuid);
  });

  it("parses when uuid is the only component", () => {
    expect(parseSmbiosUuid({ smbios1: `uuid=${uuid}` })).toBe(uuid);
  });

  it("lowercases uppercase UUIDs for stable comparison", () => {
    expect(parseSmbiosUuid({ smbios1: `uuid=${uuid.toUpperCase()}` })).toBe(
      uuid,
    );
  });

  it("returns null for a missing, malformed, or non-UUID value", () => {
    expect(parseSmbiosUuid({})).toBeNull();
    expect(parseSmbiosUuid({ smbios1: "manufacturer=DevChain" })).toBeNull();
    expect(parseSmbiosUuid({ smbios1: "uuid=not-a-uuid" })).toBeNull();
    expect(parseSmbiosUuid({ smbios1: 42 })).toBeNull();
  });
});

describe("configCarriesCloneMarker", () => {
  it("finds the exact marker inside a multi-line description", () => {
    const description = `Operator notes\n devchain-vm:11111111-1111-1111-1111-111111111111\n more`;
    expect(
      configCarriesCloneMarker(
        { description },
        "devchain-vm:11111111-1111-1111-1111-111111111111",
      ),
    ).toBe(true);
  });

  it("rejects a different resource marker and missing descriptions", () => {
    expect(
      configCarriesCloneMarker(
        { description: "devchain-vm:22222222-2222-2222-2222-222222222222" },
        "devchain-vm:11111111-1111-1111-1111-111111111111",
      ),
    ).toBe(false);
    expect(configCarriesCloneMarker({}, "devchain-vm:x")).toBe(false);
  });
});
