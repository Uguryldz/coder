import { describe, expect, it } from "vitest";
import { decodeXmlText, parseErrorCode, parseListObjectsV2, readTag } from "../src/xml.js";

const TRUNCATED_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>maestro</Name>
  <Prefix>evidence/2026/</Prefix>
  <KeyCount>2</KeyCount>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcx</NextContinuationToken>
  <Contents><Key>evidence/2026/UGURPAY-1/run/a.json</Key><Size>12</Size></Contents>
  <Contents><Key>evidence/2026/UGURPAY-1/run/b &amp; c.json</Key><Size>3</Size></Contents>
</ListBucketResult>`;

const EMPTY_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>maestro</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`;

describe("ListObjectsV2 parsing", () => {
  it("reads keys, the truncation flag and the continuation token", () => {
    expect(parseListObjectsV2(TRUNCATED_PAGE)).toEqual({
      keys: ["evidence/2026/UGURPAY-1/run/a.json", "evidence/2026/UGURPAY-1/run/b & c.json"],
      isTruncated: true,
      nextContinuationToken: "1ueGcx",
    });
  });

  it("returns an empty, non-truncated page when the bucket has no matches", () => {
    expect(parseListObjectsV2(EMPTY_PAGE)).toEqual({
      keys: [],
      isTruncated: false,
      nextContinuationToken: undefined,
    });
  });

  it("ignores CommonPrefixes entries, which are not objects", () => {
    const xml =
      `<ListBucketResult><IsTruncated>false</IsTruncated>` +
      `<CommonPrefixes><Prefix>evidence/2025/</Prefix></CommonPrefixes>` +
      `<Contents><Key>evidence/2026/a</Key></Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).keys).toEqual(["evidence/2026/a"]);
  });
});

describe("entity decoding", () => {
  it("decodes named and numeric references", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(decodeXmlText("&#65;&#x42;")).toBe("AB");
  });

  it("returns undefined for an absent tag rather than an empty string", () => {
    expect(readTag("<a><b>1</b></a>", "c")).toBeUndefined();
    expect(readTag("<a><b></b></a>", "b")).toBe("");
  });

  it("reads a tag that carries attributes", () => {
    expect(readTag('<Key xmlns="x">a/b</Key>', "Key")).toBe("a/b");
  });
});

describe("error bodies", () => {
  it("extracts the S3 error code", () => {
    expect(parseErrorCode("<Error><Code>NoSuchKey</Code><Message>x</Message></Error>")).toBe(
      "NoSuchKey",
    );
  });

  it("returns undefined for a body that is not an S3 error", () => {
    expect(parseErrorCode("<ListBucketResult><Code>x</Code></ListBucketResult>")).toBeUndefined();
    expect(parseErrorCode("plain text gateway failure")).toBeUndefined();
  });
});
